// =====================================================================
// Chatbot data-analysis service (READ-ONLY)
//
// Answers administrator questions such as:
//   - "Rahul ke pending tasks kya hain?"
//   - "Last 7 days mein kitne tasks complete hue?"
//   - "Sabse zyada overdue kis employee ke hain?"
//
// Every query runs through `chatbotReadOnlyDb`, whose connections are
// read-only at the PostgreSQL level. All user-provided values are passed as
// query parameters (never string-concatenated into SQL).
//
// Status rules mirror the existing dashboard (dashboardController.js):
//   - Leave / Inactive rows are excluded.
//   - pending   = submission_date IS NULL (includes overdue + due today)
//   - overdue   = pending AND task date < today
//   - completed = submitted (checklist additionally requires status = 'yes')
//   - not_done  = checklist submitted with status 'no' / NULL
// Date used: checklist & maintenance -> task_start_date, delegation -> planned_date
// =====================================================================

import pool from "../config/chatbotReadOnlyDb.js";

export const ADMIN_ROLES = ["super_admin", "div_admin", "admin"];

const MAX_RANGE_DAYS = 366;
const MAX_LIST_LIMIT = 50;
const MAX_EMPLOYEE_ROWS = 50;

// Same SQL as utils/activeUsers.js#activeDoerClause (the dashboard applies it to checklist).
const ACTIVE_DOER_SQL = `EXISTS (
            SELECT 1 FROM users au
            WHERE LOWER(TRIM(au.user_name)) = LOWER(TRIM(t.name))
              AND LOWER(COALESCE(au.status::text, 'active')) = 'active')`;

const CHECKLIST_PLANNED = "NULLIF(TRIM(t.planned_date), '')::timestamp";

// One entry per UNION branch. Each branch is normalised to the same columns.
// "on time" rules are copied from dashboardController.getDashboardSummaryCounts:
//   checklist   -> completed AND submission date <= planned date
//   delegation  -> submitted AND color_code_for = 1
//   maintenance -> submitted AND status = 'Done'
// Like the dashboard, the checklist type also counts completed daily work
// reports (working_date_history) as completed, on-time checklist entries.
const TASK_BRANCHES = [
    {
        taskType: "checklist",
        source: "checklist",
        from: "checklist t",
        dateCol: "t.task_start_date",
        hasTimeZone: false,
        activeDoerOnly: true,
        cols: {
            taskId: "t.task_id::text",
            description: "t.task_description",
            givenBy: "t.given_by",
            frequency: "t.frequency",
            planned: CHECKLIST_PLANNED,
            submission: "t.submission_date",
            completed: "t.submission_date IS NOT NULL AND LOWER(COALESCE(t.status::text, '')) = 'yes'",
            notDone: "t.submission_date IS NOT NULL AND (t.status IS NULL OR LOWER(t.status::text) = 'no')",
            onTime:
                "t.submission_date IS NOT NULL AND LOWER(COALESCE(t.status::text, '')) = 'yes' " +
                `AND ${CHECKLIST_PLANNED} IS NOT NULL AND t.submission_date::date <= ${CHECKLIST_PLANNED}::date`,
            delay: "t.delay::text",
            remarks: "t.remark",
            approval: "t.admin_done",
            submittedBy: "t.submitted_by",
            approvedBy: "t.approved_by",
            machine: "NULL",
            extendCount: "NULL"
        }
    },
    {
        taskType: "checklist",
        source: "work_report",
        from: `(
            SELECT w.id, w.user_name AS name, w.department, w.unit, w.division,
                   w.work_details, w.assign_by, w.work_datetime, w.status
            FROM working_date_history w
            WHERE LOWER(COALESCE(w.status, '')) = 'completed'
        ) t`,
        dateCol: "t.work_datetime",
        hasTimeZone: false,
        activeDoerOnly: true,
        cols: {
            taskId: "'WR-' || t.id::text",
            description: "t.work_details",
            givenBy: "t.assign_by",
            frequency: "'DAILY'",
            planned: "t.work_datetime",
            submission: "t.work_datetime",
            completed: "TRUE",
            notDone: "FALSE",
            onTime: "TRUE",
            delay: "'00:00:00'",
            remarks: "NULL",
            approval: "NULL",
            submittedBy: "t.name",
            approvedBy: "NULL",
            machine: "NULL",
            extendCount: "NULL"
        }
    },
    {
        taskType: "delegation",
        source: "delegation",
        from: `delegation t
            LEFT JOIN (
                SELECT
                    task_id,
                    COUNT(*) FILTER (WHERE status::text = 'extend')::int AS extend_count,
                    (ARRAY_AGG(admin_done ORDER BY created_at DESC)
                        FILTER (WHERE status::text = 'completed'))[1] AS approval,
                    (ARRAY_AGG(approved_by ORDER BY created_at DESC)
                        FILTER (WHERE status::text = 'completed'))[1] AS approved_by
                FROM delegation_done
                GROUP BY task_id
            ) dd ON dd.task_id = t.task_id`,
        dateCol: "t.planned_date",
        hasTimeZone: false,
        activeDoerOnly: false,
        cols: {
            taskId: "t.task_id::text",
            description: "t.task_description",
            givenBy: "t.given_by",
            frequency: "t.frequency",
            planned: "t.planned_date",
            submission: "t.submission_date",
            completed: "t.submission_date IS NOT NULL",
            notDone: "FALSE",
            onTime: "t.submission_date IS NOT NULL AND t.color_code_for = 1",
            delay: "t.delay::text",
            remarks: "t.remarks",
            approval: "dd.approval",
            submittedBy: "t.submitted_by",
            approvedBy: "dd.approved_by",
            machine: "NULL",
            extendCount: "COALESCE(dd.extend_count, 0)"
        }
    },
    {
        taskType: "maintenance",
        source: "maintenance",
        from: "maintenance_tasks t",
        dateCol: "t.task_start_date",
        // Maintenance dates are stored as "<date> 23:59 UTC" (= 05:29 IST next day),
        // so the task date is the UTC date - the same date the dashboard uses.
        hasTimeZone: true,
        dateZone: "UTC",
        activeDoerOnly: false,
        cols: {
            taskId: "t.id::text",
            description: "t.task_description",
            givenBy: "t.given_by",
            frequency: "t.frequency",
            planned: "(t.planned_date AT TIME ZONE 'UTC')",
            submission: "(t.submission_date AT TIME ZONE 'Asia/Kolkata')",
            completed: "t.submission_date IS NOT NULL",
            notDone: "FALSE",
            // Chatbot-only rule: the dashboard's rule (status = 'Done') never matches
            // because maintenance status is yes / no / Pending / Leave, so it always
            // shows 0. Here: submitted on or before the planned date (like checklist).
            onTime:
                "t.submission_date IS NOT NULL AND t.planned_date IS NOT NULL " +
                "AND (t.submission_date AT TIME ZONE 'UTC')::date <= (t.planned_date AT TIME ZONE 'UTC')::date",
            delay: "t.delay",
            remarks: "t.remarks",
            approval: "t.admin_done",
            submittedBy: "t.submitted_by",
            approvedBy: "t.approved_by",
            machine: "t.machine_name",
            partName: "ARRAY_TO_STRING(t.part_name, ', ')",
            partArea: "t.part_area",
            extendCount: "NULL"
        }
    }
];

const TASK_TYPES = ["all", ...new Set(TASK_BRANCHES.map((b) => b.taskType))];
const STATUS_FILTERS = [
    "all", "pending", "overdue", "due_today", "completed", "not_done",
    "on_time", "late", "extended"
];
const SORT_FIELDS = [
    "pending", "overdue", "completed", "total", "completion_rate", "on_time", "late", "extended"
];


// =====================================================================
// Date helpers (IST)
// =====================================================================

export const getISTToday = () => {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());

    const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${v.year}-${v.month}-${v.day}`;
};

const isValidDate = (date) => {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return false;
    }
    const parsed = new Date(`${date}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};

const daysBetween = (a, b) =>
    Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

// Earliest date used for "all time / shuru se ab tak" questions.
const ALL_TIME_START = "2000-01-01";

const isAllTime = (args = {}) => args.all_time === true || args.all_time === "true";

// `maxDays` is relaxed (Infinity) for count-only tools, which stay cheap over
// long ranges; row-listing tools keep the 366-day limit.
const resolveDateRange = (args = {}, { maxDays = MAX_RANGE_DAYS } = {}) => {
    const today = getISTToday();
    const allTime = isAllTime(args);
    const startDate = allTime ? ALL_TIME_START : (args.start_date || `${today.slice(0, 8)}01`);
    const endDate = allTime ? today : (args.end_date || today);

    if (!isValidDate(startDate) || !isValidDate(endDate)) {
        throw new Error("Invalid date. Use YYYY-MM-DD format.");
    }
    if (startDate > endDate) {
        throw new Error("start_date cannot be after end_date.");
    }
    if (daysBetween(startDate, endDate) > maxDays) {
        throw new Error(
            `Date range cannot be longer than ${maxDays} days for a task list. ` +
            "Use a summary tool (counts) for longer periods or all time."
        );
    }

    return { startDate, endDate, today, allTime };
};

const pickEnum = (value, allowed, fallback, label) => {
    if (value === undefined || value === null || value === "") return fallback;
    const normalized = String(value).toLowerCase().trim();
    if (!allowed.includes(normalized)) {
        throw new Error(`Invalid ${label}. Allowed: ${allowed.join(", ")}.`);
    }
    return normalized;
};

const cleanText = (value, max = 120) => {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (!text) return null;
    if (text.length > max) throw new Error("Filter value is too long.");
    return text;
};

const clampLimit = (value, fallback, max) => {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
};

const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);


// =====================================================================
// Requester profile & role scope
// =====================================================================

export const getRequesterProfile = async (username) => {
    const { rows } = await pool.query(
        `SELECT user_name, role, department, unit, division, designation
         FROM users
         WHERE LOWER(TRIM(user_name)) = LOWER(TRIM($1))
           AND status::text = 'active'
         LIMIT 1`,
        [username]
    );

    if (rows.length === 0) return null;

    return {
        ...rows[0],
        role: String(rows[0].role || "").toLowerCase()
    };
};

const assertAdmin = (profile) => {
    if (!profile || !ADMIN_ROLES.includes(profile.role)) {
        const error = new Error("Administrator access required for organisation-wide data.");
        error.statusCode = 403;
        throw error;
    }
};

// Builds the WHERE fragment that limits rows to what this admin may see,
// using the same rules as the dashboard:
//   super_admin -> everything
//   div_admin   -> own unit + division
//   admin       -> own unit + division + department(s)
const buildScope = (profile, params, alias = "t") => {
    const clauses = [];
    const add = (value) => {
        params.push(value);
        return `$${params.length}`;
    };

    if (profile.role === "div_admin" || profile.role === "admin") {
        clauses.push(`LOWER(TRIM(${alias}.unit)) = LOWER(TRIM(${add(profile.unit || "")}))`);
        clauses.push(`LOWER(TRIM(${alias}.division)) = LOWER(TRIM(${add(profile.division || "")}))`);
    }

    if (profile.role === "admin") {
        const departments = String(profile.department || "")
            .split(",")
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean);
        clauses.push(`LOWER(TRIM(${alias}.department)) = ANY(${add(departments)})`);
    }

    return clauses;
};

const describeScope = (profile) => {
    if (profile.role === "super_admin") return "All units, divisions and departments";
    if (profile.role === "div_admin") return `Unit: ${profile.unit || "-"}, Division: ${profile.division || "-"}`;
    return `Unit: ${profile.unit || "-"}, Division: ${profile.division || "-"}, Department(s): ${profile.department || "-"}`;
};


// =====================================================================
// Employee name resolution
// =====================================================================

// Distinct doer names, taken from the users table AND the task tables
// (tasks can belong to people who are no longer in / renamed in `users`).
const employeeNamesSql = (scopeFor, nameCondition) => `
    SELECT DISTINCT ON (LOWER(TRIM(n.name))) TRIM(n.name) AS name, n.department
    FROM (
        SELECT u.user_name AS name, u.department FROM users u
        WHERE ${nameCondition("u.user_name")}${scopeFor("u")}
        UNION ALL
        SELECT t.name, t.department FROM checklist t
        WHERE ${nameCondition("t.name")}${scopeFor("t")}
        UNION ALL
        SELECT t.name, t.department FROM delegation t
        WHERE ${nameCondition("t.name")}${scopeFor("t")}
        UNION ALL
        SELECT t.name, t.department FROM maintenance_tasks t
        WHERE ${nameCondition("t.name")}${scopeFor("t")}
    ) n
    WHERE n.name IS NOT NULL AND TRIM(n.name) <> ''
    ORDER BY LOWER(TRIM(n.name))
    LIMIT 10`;

// Turns a (possibly partial) name into exactly one employee name.
// Returns { name } on success, or { error, candidates } when not resolvable.
const resolveEmployee = async (rawName, profile) => {
    const name = cleanText(rawName);
    if (!name) return { name: null };

    const lookup = async (value, nameCondition) => {
        const params = [];
        // Scope placeholders are identical for every alias, so build them once.
        const scopeU = buildScope(profile, params, "ALIAS");
        params.push(value);
        const valueP = `$${params.length}`;
        const scopeFor = (alias) =>
            scopeU.length ? ` AND ${scopeU.join(" AND ").replaceAll("ALIAS.", `${alias}.`)}` : "";

        const { rows } = await pool.query(
            employeeNamesSql(scopeFor, (col) => nameCondition(col, valueP)),
            params
        );
        return rows;
    };

    const exact = await lookup(name, (col, p) => `LOWER(TRIM(${col})) = LOWER(TRIM(${p}))`);
    if (exact.length) return { name: exact[0].name };

    const partial = await lookup(`%${escapeLike(name)}%`, (col, p) => `${col} ILIKE ${p}`);

    if (partial.length === 1) return { name: partial[0].name };

    if (partial.length > 1) {
        return {
            error: `Multiple employees match "${name}". Ask the user which one they mean.`,
            candidates: partial
        };
    }

    return {
        error: `No employee named "${name}" was found${profile.role === "super_admin" ? "" : " within your access scope"}.`,
        candidates: []
    };
};


// =====================================================================
// Department name resolution
// =====================================================================

// "Operations", "operation dept", "OPERATION" -> "operation"
const normalizeDept = (value) =>
    String(value || "")
        .toLowerCase()
        .replace(/\b(department|dept|deptt|team|section)\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(" ")
        .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
        .join(" ");

// Maps a user-typed department to the exact name stored in the database.
// Returns { department } on success, or { error, candidates } when not resolvable.
const resolveDepartment = async (rawDepartment, profile) => {
    const wanted = cleanText(rawDepartment);
    if (!wanted) return { department: null };

    const params = [];
    const scope = buildScope(profile, params, "ALIAS");
    const scopeFor = (alias) =>
        scope.length ? ` AND ${scope.join(" AND ").replaceAll("ALIAS.", `${alias}.`)}` : "";

    const { rows } = await pool.query(
        `SELECT DISTINCT TRIM(d.department) AS department
         FROM (
             SELECT u.department FROM users u WHERE TRUE${scopeFor("u")}
             UNION ALL SELECT t.department FROM checklist t WHERE TRUE${scopeFor("t")}
             UNION ALL SELECT t.department FROM delegation t WHERE TRUE${scopeFor("t")}
             UNION ALL SELECT t.department FROM maintenance_tasks t WHERE TRUE${scopeFor("t")}
         ) d
         WHERE d.department IS NOT NULL AND TRIM(d.department) <> ''`,
        params
    );

    const names = rows.map((r) => r.department);
    const exact = names.find((n) => n.toLowerCase() === wanted.toLowerCase());
    if (exact) return { department: exact };

    const target = normalizeDept(wanted);
    if (!target) return { department: wanted };

    // Case variations of one name count as a single department.
    const uniqueByLower = (list) => [...new Map(list.map((n) => [n.toLowerCase(), n])).values()];

    const same = uniqueByLower(names.filter((n) => normalizeDept(n) === target));
    if (same.length === 1) return { department: same[0] };

    const partial = uniqueByLower(
        names.filter((n) => {
            const norm = normalizeDept(n);
            return norm && (norm.includes(target) || target.includes(norm));
        })
    );
    if (partial.length === 1) return { department: partial[0] };

    return {
        error: partial.length
            ? `Multiple departments match "${wanted}". Ask the user which one they mean.`
            : `No department named "${wanted}" was found. Use list_departments to show valid names.`,
        candidates: (same.length ? same : partial).slice(0, 15)
    };
};


// =====================================================================
// Unified task query builder
// =====================================================================

// Produces a CTE named `tasks` that normalises the selected task tables into
// one shape, already filtered by date range, role scope and optional filters.
const buildTasksCte = (profile, filters) => {
    const { taskType, startDate, endDate, employee, department, unit, division } = filters;

    const params = [];
    const add = (value) => {
        params.push(value);
        return `$${params.length}`;
    };

    const startP = add(startDate);
    const endP = add(endDate);

    // Shared filters (same placeholders reused in every UNION branch)
    const shared = buildScope(profile, params);
    if (employee) shared.push(`LOWER(TRIM(t.name)) = LOWER(TRIM(${add(employee)}))`);
    if (department) shared.push(`LOWER(TRIM(t.department)) = LOWER(TRIM(${add(department)}))`);
    if (unit) shared.push(`LOWER(TRIM(t.unit)) = LOWER(TRIM(${add(unit)}))`);
    if (division) shared.push(`LOWER(TRIM(t.division)) = LOWER(TRIM(${add(division)}))`);

    const selected = TASK_BRANCHES.filter(
        (b) => taskType === "all" || b.taskType === taskType
    );

    const branches = selected.map((b) => {
        const c = b.cols;
        const col = b.dateCol;
        const dateExpr = b.hasTimeZone
            ? `(${col} AT TIME ZONE '${b.dateZone || "Asia/Kolkata"}')::date`
            : `${col}::date`;
        // Range on the raw column for timestamp tables keeps it index-friendly.
        const rangeSql = b.hasTimeZone
            ? `${dateExpr} BETWEEN ${startP}::date AND ${endP}::date`
            : `${col} >= ${startP}::date AND ${col} < (${endP}::date + 1)`;

        const where = [
            "(t.status IS NULL OR LOWER(t.status::text) NOT IN ('leave', 'inactive'))",
            rangeSql,
            ...(b.activeDoerOnly ? [ACTIVE_DOER_SQL] : []),
            ...shared
        ].join("\n          AND ");

        return `
        SELECT
            '${b.taskType}'::text AS task_type,
            '${b.source}'::text AS source,
            (${c.taskId})::text AS task_id,
            TRIM(t.name) AS employee,
            t.department,
            t.unit,
            t.division,
            (${c.description})::text AS task_description,
            (${c.givenBy})::text AS given_by,
            (${c.frequency})::text AS frequency,
            ${dateExpr} AS task_date,
            (${c.planned})::timestamp AS planned_at,
            (${c.submission})::timestamp AS submission_date,
            COALESCE(${c.completed}, FALSE) AS is_completed,
            COALESCE(${c.notDone}, FALSE) AS is_not_done,
            COALESCE(${c.onTime}, FALSE) AS is_on_time,
            t.status::text AS raw_status,
            (${c.delay})::text AS delay,
            (${c.remarks})::text AS remarks,
            (${c.approval})::text AS approval,
            (${c.submittedBy})::text AS submitted_by,
            (${c.approvedBy})::text AS approved_by,
            (${c.machine})::text AS machine_name,
            (${c.partName || "NULL"})::text AS part_name,
            (${c.partArea || "NULL"})::text AS part_area,
            (${c.extendCount})::int AS extend_count
        FROM ${b.from}
        WHERE ${where}`;
    });

    return { cte: `WITH tasks AS (${branches.join("\n        UNION ALL\n")}\n)`, params, add };
};

const countColumns = (todayP) => `
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE is_completed)::int AS completed,
    COUNT(*) FILTER (WHERE submission_date IS NULL)::int AS pending,
    COUNT(*) FILTER (WHERE submission_date IS NULL AND task_date < ${todayP}::date)::int AS overdue,
    COUNT(*) FILTER (WHERE submission_date IS NULL AND task_date = ${todayP}::date)::int AS due_today,
    COUNT(*) FILTER (WHERE is_not_done)::int AS not_done,
    COUNT(*) FILTER (WHERE is_completed AND is_on_time)::int AS on_time,
    COUNT(*) FILTER (WHERE is_completed AND NOT is_on_time)::int AS late,
    COUNT(*) FILTER (WHERE extend_count > 0)::int AS extended`;

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

// on_time_rate_percent = on_time / completed, the same ratio as the dashboard's "On Time" card.
const withRate = (row) => ({
    ...row,
    completion_rate_percent: pct(row.completed, row.total),
    on_time_rate_percent: pct(row.on_time, row.completed)
});

const readCommonFilters = async (args, profile, { maxDays = MAX_RANGE_DAYS } = {}) => {
    const taskType = pickEnum(args.task_type, TASK_TYPES, "all", "task_type");
    const { startDate, endDate, today, allTime } = resolveDateRange(args, { maxDays });

    let employee = null;
    if (args.employee_name) {
        const resolved = await resolveEmployee(args.employee_name, profile);
        if (resolved.error) return { failure: { success: false, message: resolved.error, candidates: resolved.candidates } };
        employee = resolved.name;
    }

    const dept = await resolveDepartment(args.department, profile);
    if (dept.error) return { failure: { success: false, message: dept.error, candidates: dept.candidates } };

    return {
        filters: {
            taskType,
            startDate,
            endDate,
            today,
            allTime,
            employee,
            department: dept.department,
            unit: profile.role === "super_admin" ? cleanText(args.unit) : null,
            division: profile.role === "super_admin" ? cleanText(args.division) : null
        }
    };
};

const describeFilters = (f) => ({
    task_type: f.taskType,
    ...(f.allTime ? { all_time: true } : {}),
    start_date: f.startDate,
    end_date: f.endDate,
    today: f.today,
    employee: f.employee || "all",
    department: f.department || "all",
    ...(f.unit ? { unit: f.unit } : {}),
    ...(f.division ? { division: f.division } : {})
});


// =====================================================================
// TOOL 1: Task summary counts
// =====================================================================

export const getTaskSummary = async (args, profile) => {
    assertAdmin(profile);
    const { filters, failure } = await readCommonFilters(args, profile, { maxDays: Infinity });
    if (failure) return failure;

    const { cte, params, add } = buildTasksCte(profile, filters);
    const todayP = add(filters.today);

    const { rows } = await pool.query(
        `${cte}
        SELECT task_type, ${countColumns(todayP)}
        FROM tasks
        GROUP BY task_type
        ORDER BY task_type`,
        params
    );

    const empty = {
        total: 0, completed: 0, pending: 0, overdue: 0, due_today: 0, not_done: 0,
        on_time: 0, late: 0, extended: 0
    };
    const combined = rows.reduce((acc, r) => {
        for (const k of Object.keys(empty)) acc[k] += r[k];
        return acc;
    }, { ...empty });

    return {
        success: true,
        filters: describeFilters(filters),
        access_scope: describeScope(profile),
        definitions:
            "pending = not yet submitted (includes overdue and due_today); overdue = pending with task date before today; completed = submitted (checklist: marked yes); not_done = checklist submitted as 'no'; on_time / late = completed tasks done on time / late (checklist and maintenance: submitted on or before the planned date; delegation: color code 1). NOTE: the dashboard currently shows maintenance On Time as 0 because its rule checks a status value that never occurs; the chatbot's maintenance on-time is the real figure, so it will differ from the dashboard for maintenance only; on_time_rate_percent = on_time / completed (same as the dashboard On Time %); extended = delegation tasks that were extended at least once. Checklist counts include completed daily work reports, exactly like the dashboard.",
        overall: withRate(combined),
        by_task_type: rows.map(withRate)
    };
};


// =====================================================================
// TOOL 2: Employee-wise breakdown
// =====================================================================

export const getEmployeeWiseSummary = async (args, profile, { maxLimit = MAX_EMPLOYEE_ROWS } = {}) => {
    assertAdmin(profile);
    const { filters, failure } = await readCommonFilters(
        { ...args, employee_name: null },
        profile,
        { maxDays: Infinity }
    );
    if (failure) return failure;

    const sortBy = pickEnum(args.sort_by, SORT_FIELDS, "pending", "sort_by");
    const limit = clampLimit(args.limit, 15, maxLimit);

    const { cte, params, add } = buildTasksCte(profile, filters);
    const todayP = add(filters.today);
    const limitP = add(limit);

    const orderSql = sortBy === "completion_rate"
        ? "(completed::numeric / NULLIF(total, 0)) DESC NULLS LAST, total DESC"
        : `${sortBy} DESC, total DESC`;

    const { rows } = await pool.query(
        `${cte},
        per_employee AS (
            SELECT employee, MAX(department) AS department, ${countColumns(todayP)}
            FROM tasks
            WHERE employee IS NOT NULL AND employee <> ''
            GROUP BY employee
        )
        SELECT *, COUNT(*) OVER ()::int AS employee_count
        FROM per_employee
        ORDER BY ${orderSql}
        LIMIT ${limitP}`,
        params
    );

    return {
        success: true,
        filters: describeFilters(filters),
        access_scope: describeScope(profile),
        export_filters: { ...describeFilters(filters), sort_by: sortBy },
        sorted_by: sortBy,
        employees_with_tasks: rows[0]?.employee_count ?? 0,
        showing: rows.length,
        employees: rows.map(({ employee_count, ...r }) => withRate(r))
    };
};


// =====================================================================
// TOOL 3: List individual tasks
// =====================================================================

const STATUS_SQL = {
    all: "TRUE",
    pending: "submission_date IS NULL",
    overdue: "submission_date IS NULL AND task_date < $TODAY::date",
    due_today: "submission_date IS NULL AND task_date = $TODAY::date",
    completed: "is_completed",
    not_done: "is_not_done",
    on_time: "is_completed AND is_on_time",
    late: "is_completed AND NOT is_on_time",
    extended: "extend_count > 0"
};

// Drops null / empty fields so the AI gets compact rows.
const compactRow = (row) =>
    Object.fromEntries(
        Object.entries(row).filter(([, v]) => v !== null && v !== undefined && v !== "")
    );

export const MAX_EXPORT_ROWS = 5000;

// `maxLimit` lets the export endpoint fetch more rows than the AI chat may.
export const listTasks = async (args, profile, { maxLimit = MAX_LIST_LIMIT } = {}) => {
    assertAdmin(profile);
    const { filters, failure } = await readCommonFilters(args, profile);
    if (failure) return failure;

    const status = pickEnum(args.status, STATUS_FILTERS, "pending", "status");
    const limit = clampLimit(args.limit, 20, maxLimit);

    const { cte, params, add } = buildTasksCte(profile, filters);
    const todayP = add(filters.today);
    const limitP = add(limit);
    const statusSql = STATUS_SQL[status].replaceAll("$TODAY", todayP);

    const { rows } = await pool.query(
        `${cte}
        SELECT
            task_type,
            NULLIF(source, task_type) AS source,
            task_id, employee, department, task_description, given_by, frequency,
            to_char(task_date, 'YYYY-MM-DD') AS task_date,
            to_char(planned_at, 'YYYY-MM-DD HH24:MI') AS planned_date,
            to_char(submission_date, 'YYYY-MM-DD HH24:MI') AS submitted_at,
            CASE
                WHEN is_not_done THEN 'not_done'
                WHEN is_completed THEN 'completed'
                WHEN submission_date IS NOT NULL THEN 'submitted'
                WHEN raw_status = 'extend' THEN 'extended_pending'
                WHEN task_date < ${todayP}::date THEN 'overdue'
                WHEN task_date = ${todayP}::date THEN 'due_today'
                ELSE 'upcoming'
            END AS current_status,
            CASE WHEN is_completed THEN (CASE WHEN is_on_time THEN 'on_time' ELSE 'late' END) END AS timeliness,
            NULLIF(delay, '00:00:00') AS delay,
            NULLIF(extend_count, 0) AS times_extended,
            remarks, approval, submitted_by, approved_by, machine_name,
            LEFT(part_name, 200) AS part_name,
            part_area,
            COUNT(*) OVER ()::int AS total_matching
        FROM tasks
        WHERE ${statusSql}
        ORDER BY task_date DESC, employee
        LIMIT ${limitP}`,
        params
    );

    const totalMatching = rows[0]?.total_matching ?? 0;

    return {
        success: true,
        filters: { ...describeFilters(filters), status },
        access_scope: describeScope(profile),
        total_matching: totalMatching,
        showing: rows.length,
        note: totalMatching > rows.length
            ? `Only the latest ${rows.length} of ${totalMatching} matching tasks are listed. Use get_task_summary / get_employee_wise_summary for full counts.`
            : undefined,
        tasks: rows.map(({ total_matching, ...r }) => compactRow(r))
    };
};


// Converts the `filters` object returned by listTasks back into tool args.
// Used to re-run the same (already resolved) query for PDF / Excel export.
export const exportArgsFromFilters = (filters = {}) => {
    const val = (v) => (v && v !== "all" ? String(v) : undefined);

    return {
        task_type: val(filters.task_type),
        start_date: val(filters.start_date),
        end_date: val(filters.end_date),
        employee_name: val(filters.employee),
        department: val(filters.department),
        unit: val(filters.unit),
        division: val(filters.division),
        status: filters.status || "pending",
        sort_by: filters.sort_by
    };
};

// Re-runs a chat query with a high row limit for PDF / Excel download.
export const runExport = async (type, filters, profile) => {
    const args = exportArgsFromFilters(filters);

    if (type === "tasks") {
        return listTasks({ ...args, limit: MAX_EXPORT_ROWS }, profile, { maxLimit: MAX_EXPORT_ROWS });
    }

    if (type === "employee_summary") {
        return getEmployeeWiseSummary({ ...args, limit: 1000 }, profile, { maxLimit: 1000 });
    }

    if (type === "employees") {
        return findEmployees(
            { query: filters.query, department: filters.department, limit: MAX_EXPORT_ROWS },
            profile,
            { maxLimit: MAX_EXPORT_ROWS }
        );
    }

    throw new Error("Unsupported export type.");
};


// =====================================================================
// TOOL 4: Find employees by name
// =====================================================================

export const findEmployees = async (args, profile, { maxLimit = 100 } = {}) => {
    assertAdmin(profile);
    const query = cleanText(args.query, 80);
    const dept = await resolveDepartment(args.department, profile);
    if (dept.error) return { success: false, message: dept.error, candidates: dept.candidates };
    const department = dept.department;
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), maxLimit);

    const params = [];
    const where = buildScope(profile, params, "u");

    if (query) {
        params.push(`%${escapeLike(query)}%`);
        where.push(`u.user_name ILIKE $${params.length}`);
    }
    if (department) {
        params.push(department);
        where.push(`LOWER(TRIM(u.department)) = LOWER(TRIM($${params.length}))`);
    }
    if (!query && !department) {
        throw new Error("Provide a name query or a department.");
    }

    params.push(limit);
    const { rows } = await pool.query(
        `SELECT u.user_name, u.employee_id, u.department, u.designation, u.unit, u.division,
                u.role, u.status::text AS status, COUNT(*) OVER()::int AS total_matching
         FROM users u
         WHERE ${where.join(" AND ")}
         ORDER BY (u.status::text = 'active') DESC, u.user_name
         LIMIT $${params.length}`,
        params
    );

    return {
        success: true,
        total_matching: rows[0]?.total_matching || 0,
        showing: rows.length,
        filters: { query: query || null, department: department || null },
        employees: rows.map(({ total_matching, ...r }) => r)
    };
};


// =====================================================================
// TOOL 5: List departments
// =====================================================================

export const listDepartments = async (args, profile) => {
    assertAdmin(profile);

    const params = [];
    const where = [
        "u.department IS NOT NULL",
        "TRIM(u.department) <> ''",
        "u.status::text = 'active'",
        ...buildScope(profile, params, "u")
    ];

    const { rows } = await pool.query(
        `SELECT TRIM(u.department) AS department, u.unit, u.division, COUNT(*)::int AS active_employees
         FROM users u
         WHERE ${where.join(" AND ")}
         GROUP BY TRIM(u.department), u.unit, u.division
         ORDER BY u.unit, u.division, department`,
        params
    );

    return { success: true, access_scope: describeScope(profile), departments: rows };
};


// Shared optional filters for the tools below: employee, department, unit, division.
// Returns { where, failure } with conditions on `alias` appended to `params`.
const buildPersonFilters = async (args, profile, params, alias, nameCol = "name") => {
    const where = buildScope(profile, params, alias);

    if (args.employee_name) {
        const resolved = await resolveEmployee(args.employee_name, profile);
        if (resolved.error) {
            return { failure: { success: false, message: resolved.error, candidates: resolved.candidates } };
        }
        params.push(resolved.name);
        where.push(`LOWER(TRIM(${alias}.${nameCol})) = LOWER(TRIM($${params.length}))`);
    }

    const dept = await resolveDepartment(args.department, profile);
    if (dept.error) {
        return { failure: { success: false, message: dept.error, candidates: dept.candidates } };
    }
    if (dept.department) {
        params.push(dept.department);
        where.push(`LOWER(TRIM(${alias}.department)) = LOWER(TRIM($${params.length}))`);
    }

    if (profile.role === "super_admin") {
        for (const key of ["unit", "division"]) {
            const value = cleanText(args[key]);
            if (value) {
                params.push(value);
                where.push(`LOWER(TRIM(${alias}.${key})) = LOWER(TRIM($${params.length}))`);
            }
        }
    }

    return { where, department: dept.department };
};


// =====================================================================
// TOOL 6: Extended delegation tasks (delegation_done, status 'extend')
// =====================================================================

const EXTENDED_STATUS = ["all", "pending", "completed"];

export const listExtendedDelegations = async (args, profile, { maxLimit = MAX_LIST_LIMIT } = {}) => {
    assertAdmin(profile);
    const { startDate, endDate, today } = resolveDateRange(args, { maxDays: Infinity });
    const status = pickEnum(args.status, EXTENDED_STATUS, "all", "status");
    const limit = clampLimit(args.limit, 20, maxLimit);

    const params = [startDate, endDate];
    const filters = await buildPersonFilters(args, profile, params, "d");
    if (filters.failure) return filters.failure;

    const where = [...filters.where];
    if (status === "pending") where.push("d.submission_date IS NULL");
    if (status === "completed") where.push("d.submission_date IS NOT NULL");

    params.push(today);
    const todayP = `$${params.length}`;
    params.push(limit);
    const limitP = `$${params.length}`;

    // An extension is counted in the range by the date it was requested.
    const { rows } = await pool.query(
        `WITH ext AS (
            SELECT
                dd.task_id,
                COUNT(*)::int AS extend_count,
                MAX(dd.created_at) AS last_extended_at,
                (ARRAY_AGG(dd.next_extend_date ORDER BY dd.created_at DESC))[1] AS extended_to,
                (ARRAY_AGG(dd.reason ORDER BY dd.created_at DESC))[1] AS last_reason
            FROM delegation_done dd
            WHERE dd.status::text = 'extend'
              AND (dd.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
            GROUP BY dd.task_id
        )
        SELECT
            d.task_id::text AS task_id,
            TRIM(d.name) AS employee,
            d.department,
            d.task_description,
            d.given_by,
            e.extend_count AS times_extended,
            to_char(e.last_extended_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS last_extended_on,
            to_char(e.extended_to, 'YYYY-MM-DD HH24:MI') AS extended_to,
            e.last_reason AS extension_reason,
            to_char(d.planned_date, 'YYYY-MM-DD HH24:MI') AS current_planned_date,
            to_char(d.submission_date, 'YYYY-MM-DD HH24:MI') AS submitted_at,
            CASE
                WHEN d.submission_date IS NOT NULL THEN
                    CASE WHEN d.color_code_for = 1 THEN 'completed_on_time' ELSE 'completed_late' END
                WHEN d.planned_date::date < ${todayP}::date THEN 'overdue'
                WHEN d.status = 'extend' THEN 'extended_pending'
                ELSE 'pending'
            END AS current_status,
            COUNT(*) OVER ()::int AS total_matching,
            SUM(e.extend_count) OVER ()::int AS total_extensions,
            COUNT(*) FILTER (WHERE d.submission_date IS NULL) OVER ()::int AS still_pending
        FROM ext e
        JOIN delegation d ON d.task_id = e.task_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY e.last_extended_at DESC
        LIMIT ${limitP}`,
        params
    );

    const first = rows[0] || {};

    return {
        success: true,
        filters: {
            start_date: startDate,
            end_date: endDate,
            date_basis: "date the extension was requested",
            status,
            employee: args.employee_name || "all",
            department: filters.department || "all"
        },
        access_scope: describeScope(profile),
        extended_tasks: first.total_matching || 0,
        total_extensions: first.total_extensions || 0,
        still_pending: first.still_pending || 0,
        showing: rows.length,
        tasks: rows.map(({ total_matching, total_extensions, still_pending, ...r }) => compactRow(r))
    };
};


// =====================================================================
// TOOL 7: Employees' daily work reports (working_date_history)
// =====================================================================

const WORK_REPORT_STATUS = ["all", "completed", "in progress", "pending"];

export const getWorkReports = async (args, profile, { maxLimit = MAX_LIST_LIMIT } = {}) => {
    assertAdmin(profile);
    const { startDate, endDate } = resolveDateRange(args, { maxDays: Infinity });
    const status = pickEnum(args.status, WORK_REPORT_STATUS, "all", "status");
    const limit = clampLimit(args.limit, 20, maxLimit);

    const params = [startDate, endDate];
    const filters = await buildPersonFilters(args, profile, params, "w", "user_name");
    if (filters.failure) return filters.failure;

    const where = [
        "w.work_datetime >= $1::date",
        "w.work_datetime < ($2::date + 1)",
        ...filters.where
    ];
    if (status !== "all") {
        params.push(status);
        where.push(`LOWER(TRIM(COALESCE(w.status, ''))) = $${params.length}`);
    }

    const whereSql = where.join(" AND ");

    const [summary, list] = await Promise.all([
        pool.query(
            `SELECT
                COUNT(*)::int AS total_reports,
                COUNT(DISTINCT LOWER(TRIM(w.user_name)))::int AS employees_reporting,
                COUNT(*) FILTER (WHERE LOWER(w.status) = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE LOWER(w.status) = 'in progress')::int AS in_progress,
                COUNT(*) FILTER (WHERE LOWER(w.status) = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE w.status IS NULL OR TRIM(w.status) = '')::int AS no_status
             FROM working_date_history w
             WHERE ${whereSql}`,
            params
        ),
        pool.query(
            `SELECT
                w.id::text AS report_id,
                to_char(w.work_datetime, 'YYYY-MM-DD HH24:MI') AS work_datetime,
                TRIM(w.user_name) AS employee,
                w.department,
                LEFT(w.work_details, 300) AS work_details,
                w.status,
                w.duration,
                w.assign_by
             FROM working_date_history w
             WHERE ${whereSql}
             ORDER BY w.work_datetime DESC NULLS LAST
             LIMIT $${params.length + 1}`,
            [...params, limit]
        )
    ]);

    return {
        success: true,
        filters: {
            start_date: startDate,
            end_date: endDate,
            status,
            employee: args.employee_name || "all",
            department: filters.department || "all"
        },
        access_scope: describeScope(profile),
        summary: summary.rows[0],
        showing: list.rows.length,
        reports: list.rows.map(compactRow)
    };
};


// =====================================================================
// Shared helpers for the organisation / machine tools below
// =====================================================================

const whereSql = (clauses) => (clauses.length ? `WHERE ${clauses.join(" AND ")}` : "");

// Equipment / repair tables have machine_division + machine_department (no unit).
const buildMachineScope = (profile, params, alias) => {
    const clauses = [];

    if (profile.role === "div_admin" || profile.role === "admin") {
        params.push(profile.division || "");
        clauses.push(`LOWER(TRIM(${alias}.machine_division)) = LOWER(TRIM($${params.length}))`);
    }

    if (profile.role === "admin") {
        const departments = String(profile.department || "")
            .split(",")
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean);
        params.push(departments);
        clauses.push(`LOWER(TRIM(${alias}.machine_department)) = ANY($${params.length})`);
    }

    return clauses;
};

// "Higher is better" per sortable metric; used to put the worst rows first.
const HIGHER_IS_BETTER = {
    on_time_rate: true,
    completion_rate: true,
    total: true,
    completed: true,
    on_time: true,
    overdue: false,
    pending: false,
    late: false,
    not_done: false,
    repairs: false
};

const metricValue = (row, metric) =>
    metric === "on_time_rate"
        ? row.on_time_rate_percent
        : metric === "completion_rate"
            ? row.completion_rate_percent
            : Number(row[metric] || 0);

const sortRows = (rows, metric, order) => {
    const better = HIGHER_IS_BETTER[metric] !== false;
    const worstFirst = order !== "best_first";
    // worst_first: ascending "goodness"; best_first: descending.
    const sign = (better ? 1 : -1) * (worstFirst ? 1 : -1);
    return [...rows].sort((a, b) => sign * (metricValue(a, metric) - metricValue(b, metric)));
};

const sumCounts = (rows) => {
    const keys = ["total", "completed", "pending", "overdue", "due_today", "not_done", "on_time", "late", "extended"];
    const total = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const r of rows) for (const k of keys) total[k] += Number(r[k] || 0);
    return withRate(total);
};

const ROLE_FILTER_SQL = {
    user: "LOWER(COALESCE(u.role::text, '')) = 'user'",
    admins: "LOWER(COALESCE(u.role::text, '')) IN ('admin', 'div_admin', 'super_admin')",
    all: "TRUE"
};


// =====================================================================
// TOOL 8: System overview (people, roles, departments, machines, totals)
// =====================================================================

export const getSystemOverview = async (args, profile) => {
    assertAdmin(profile);

    const uParams = [];
    const uScope = buildScope(profile, uParams, "u");
    const uWhere = ["TRIM(COALESCE(u.user_name, '')) <> ''", ...uScope].join(" AND ");

    const eParams = [];
    const eWhere = whereSql(buildMachineScope(profile, eParams, "e"));
    const pParams = [];
    const pWhere = whereSql(buildMachineScope(profile, pParams, "p"));
    const rParams = [];
    const rWhere = whereSql(buildMachineScope(profile, rParams, "r"));

    const mParams = [];
    const mWhere = whereSql([
        "TRIM(COALESCE(t.machine_name, '')) <> ''",
        ...buildScope(profile, mParams, "t")
    ]);
    const dParams = [];
    const dWhere = whereSql(["dd.status::text = 'extend'", ...buildScope(profile, dParams, "d")]);
    const wParams = [];
    const wWhere = whereSql(buildScope(profile, wParams, "w"));

    const [people, departments, equipment, parts, maintMachines, repairs, extended, workReports, tasks] =
        await Promise.all([
            pool.query(
                `SELECT
                    COUNT(*)::int AS total_people,
                    COUNT(*) FILTER (WHERE u.status::text = 'active')::int AS active,
                    COUNT(*) FILTER (WHERE u.status::text = 'inactive')::int AS inactive,
                    COUNT(*) FILTER (WHERE u.status::text = 'on_leave')::int AS on_leave,
                    COUNT(*) FILTER (WHERE u.status::text = 'terminated')::int AS terminated,
                    COUNT(*) FILTER (WHERE u.status IS NULL)::int AS no_status,
                    COUNT(*) FILTER (WHERE u.status::text = 'active' AND LOWER(u.role::text) = 'user')::int AS active_employees,
                    COUNT(*) FILTER (WHERE u.status::text = 'active' AND LOWER(u.role::text) = 'admin')::int AS active_admins,
                    COUNT(*) FILTER (WHERE u.status::text = 'active' AND LOWER(u.role::text) = 'div_admin')::int AS active_div_admins,
                    COUNT(*) FILTER (WHERE u.status::text = 'active' AND LOWER(u.role::text) = 'super_admin')::int AS active_super_admins,
                    COUNT(DISTINCT LOWER(TRIM(u.unit))) FILTER (WHERE u.status::text = 'active' AND TRIM(COALESCE(u.unit, '')) <> '')::int AS units,
                    COUNT(DISTINCT LOWER(TRIM(u.division))) FILTER (WHERE u.status::text = 'active' AND TRIM(COALESCE(u.division, '')) <> '')::int AS divisions
                 FROM users u
                 WHERE ${uWhere}`,
                uParams
            ),
            // Admins can hold several departments ("A,B"), so split before counting.
            pool.query(
                `SELECT COUNT(DISTINCT LOWER(TRIM(d)))::int AS departments
                 FROM users u, UNNEST(STRING_TO_ARRAY(u.department, ',')) AS d
                 WHERE ${uWhere} AND u.status::text = 'active' AND TRIM(d) <> ''`,
                uParams
            ),
            pool.query(
                `SELECT COALESCE(NULLIF(TRIM(e.status), ''), 'Unknown') AS status, COUNT(*)::int AS count
                 FROM equipment_master e ${eWhere}
                 GROUP BY 1 ORDER BY 2 DESC`,
                eParams
            ),
            pool.query(`SELECT COUNT(*)::int AS count FROM machine_parts p ${pWhere}`, pParams),
            pool.query(
                `SELECT COUNT(DISTINCT LOWER(TRIM(t.machine_name)))::int AS count
                 FROM maintenance_tasks t ${mWhere}`,
                mParams
            ),
            pool.query(
                `SELECT COALESCE(NULLIF(TRIM(r.status), ''), 'Unknown') AS status, COUNT(*)::int AS count
                 FROM repair_tasks r ${rWhere}
                 GROUP BY 1 ORDER BY 2 DESC`,
                rParams
            ),
            pool.query(
                `SELECT COUNT(DISTINCT dd.task_id)::int AS tasks, COUNT(*)::int AS extensions
                 FROM delegation_done dd JOIN delegation d ON d.task_id = dd.task_id ${dWhere}`,
                dParams
            ),
            pool.query(`SELECT COUNT(*)::int AS count FROM working_date_history w ${wWhere}`, wParams),
            getTaskSummary({ all_time: true }, profile)
        ]);

    const sumBy = (rows) => rows.reduce((n, r) => n + r.count, 0);

    return {
        success: true,
        access_scope: describeScope(profile),
        system_modules:
            "Checklist (recurring tasks), Delegation (one-time tasks with extensions), Maintenance (machine maintenance tasks), " +
            "Daily work reports, Equipment / machine register, Machine parts, Repair tasks. " +
            "Also in the app but NOT readable by this assistant: leave, holidays, documents / subscriptions, asset management, WhatsApp settings.",
        people: {
            ...people.rows[0],
            definitions:
                "total_people counts user accounts that have a user name; active_employees = active users with role 'user'; " +
                "admins / div_admins / super_admins are counted among active accounts only."
        },
        organisation: {
            units: people.rows[0].units,
            divisions: people.rows[0].divisions,
            departments: departments.rows[0].departments
        },
        machines: {
            equipment_registered: sumBy(equipment.rows),
            equipment_by_status: equipment.rows,
            machine_parts_registered: parts.rows[0].count,
            machines_with_maintenance_tasks: maintMachines.rows[0].count,
            repair_tasks_total: sumBy(repairs.rows),
            repair_tasks_by_status: repairs.rows
        },
        tasks_all_time: {
            date_range: `${tasks.filters?.start_date} to ${tasks.filters?.end_date}`,
            overall: tasks.overall,
            by_task_type: tasks.by_task_type
        },
        delegation_extensions_all_time: extended.rows[0],
        work_reports_all_time: workReports.rows[0].count
    };
};


// =====================================================================
// TOOL 9: Active people with NO task assigned in a period
// =====================================================================

// Only real (non leave / inactive) tasks count as "assigned".
const DOER_SOURCES = {
    checklist: {
        table: "checklist",
        dateExpr: "task_start_date::date",
        range: "task_start_date >= $1::date AND task_start_date < ($2::date + 1)"
    },
    delegation: {
        table: "delegation",
        dateExpr: "planned_date::date",
        range: "planned_date >= $1::date AND planned_date < ($2::date + 1)"
    },
    maintenance: {
        table: "maintenance_tasks",
        dateExpr: "(task_start_date AT TIME ZONE 'UTC')::date",
        range: "(task_start_date AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date"
    }
};

export const listEmployeesWithoutTasks = async (args, profile, { maxLimit = MAX_LIST_LIMIT } = {}) => {
    assertAdmin(profile);
    const { startDate, endDate, allTime } = resolveDateRange(args, { maxDays: Infinity });
    const taskType = pickEnum(args.task_type, TASK_TYPES, "all", "task_type");
    const role = pickEnum(args.role, Object.keys(ROLE_FILTER_SQL), "user", "role");
    const limit = clampLimit(args.limit, 50, maxLimit);

    const dept = await resolveDepartment(args.department, profile);
    if (dept.error) return { success: false, message: dept.error, candidates: dept.candidates };

    const keys = taskType === "all" ? Object.keys(DOER_SOURCES) : [taskType];
    const notLeave = "(status IS NULL OR LOWER(status::text) NOT IN ('leave', 'inactive'))";

    const inRange = keys
        .map((k) => `SELECT LOWER(TRIM(name)) AS n FROM ${DOER_SOURCES[k].table} WHERE ${DOER_SOURCES[k].range} AND ${notLeave}`)
        .join("\n            UNION\n            ");
    const lastAny = keys
        .map((k) => `SELECT LOWER(TRIM(name)) AS n, MAX(${DOER_SOURCES[k].dateExpr}) AS d FROM ${DOER_SOURCES[k].table} WHERE ${notLeave} GROUP BY 1`)
        .join("\n                UNION ALL\n                ");

    const params = [startDate, endDate];
    const where = [
        "u.status::text = 'active'",
        "TRIM(COALESCE(u.user_name, '')) <> ''",
        ROLE_FILTER_SQL[role],
        ...buildScope(profile, params, "u")
    ];
    if (dept.department) {
        params.push(dept.department);
        where.push(`LOWER(TRIM(u.department)) = LOWER(TRIM($${params.length}))`);
    }

    // MATERIALIZED: build each name set once, instead of re-scanning the task
    // tables for every user (that is what made the all-time version time out).
    const baseCte = `
        WITH in_range AS MATERIALIZED (
            ${inRange}
        ),
        last_any AS MATERIALIZED (
            SELECT n, MAX(d) AS last_date FROM (
                ${lastAny}
            ) x GROUP BY n
        ),
        base AS (
            SELECT u.user_name, u.employee_id, u.department, u.designation,
                   LOWER(u.role::text) AS role, l.last_date,
                   EXISTS (SELECT 1 FROM in_range r WHERE r.n = LOWER(TRIM(u.user_name))) AS has_tasks
            FROM users u
            LEFT JOIN last_any l ON l.n = LOWER(TRIM(u.user_name))
            WHERE ${where.join(" AND ")}
        )`;

    const [byDept, list] = await Promise.all([
        pool.query(
            `${baseCte}
            SELECT COALESCE(NULLIF(TRIM(department), ''), '(no department)') AS department,
                   COUNT(*)::int AS active_people,
                   COUNT(*) FILTER (WHERE NOT has_tasks)::int AS without_tasks
            FROM base
            GROUP BY 1
            ORDER BY without_tasks DESC, department`,
            params
        ),
        pool.query(
            `${baseCte}
            SELECT TRIM(user_name) AS employee, employee_id, department, designation, role,
                   COALESCE(to_char(last_date, 'YYYY-MM-DD'), 'never') AS last_task_date
            FROM base
            WHERE NOT has_tasks
            ORDER BY last_date NULLS FIRST, department, user_name
            LIMIT $${params.length + 1}`,
            [...params, limit]
        )
    ]);

    const activePeople = byDept.rows.reduce((n, r) => n + r.active_people, 0);
    const withoutTasks = byDept.rows.reduce((n, r) => n + r.without_tasks, 0);

    return {
        success: true,
        filters: {
            ...(allTime ? { all_time: true } : {}),
            start_date: startDate,
            end_date: endDate,
            task_type: taskType,
            role,
            department: dept.department || "all"
        },
        access_scope: describeScope(profile),
        definitions:
            "without_tasks = active people with no checklist / delegation / maintenance task (excluding leave rows) dated in the range. " +
            "last_task_date = their latest task date ever ('never' = no task at all). role 'user' = regular employees (admins usually assign tasks).",
        active_people: activePeople,
        without_tasks: withoutTasks,
        with_tasks: activePeople - withoutTasks,
        by_department: byDept.rows.filter((r) => r.without_tasks > 0),
        showing: list.rows.length,
        people: list.rows.map(compactRow)
    };
};


// =====================================================================
// TOOL 10: Department-wise performance (where to improve)
// =====================================================================

const DEPT_SORT = ["on_time_rate", "completion_rate", "overdue", "pending", "late", "not_done", "total"];

export const getDepartmentWiseSummary = async (args, profile) => {
    assertAdmin(profile);
    const { filters, failure } = await readCommonFilters(
        { ...args, employee_name: null, department: null },
        profile,
        { maxDays: Infinity }
    );
    if (failure) return failure;

    const sortBy = pickEnum(args.sort_by, DEPT_SORT, "on_time_rate", "sort_by");
    const order = pickEnum(args.order, ["worst_first", "best_first"], "worst_first", "order");
    const minTasks = clampLimit(args.min_tasks, 5, 1000000);

    const { cte, params, add } = buildTasksCte(profile, filters);
    const todayP = add(filters.today);

    const { rows } = await pool.query(
        `${cte}
        SELECT MAX(TRIM(department)) AS department,
               COUNT(DISTINCT LOWER(employee))::int AS employees,
               ${countColumns(todayP)}
        FROM tasks
        WHERE TRIM(COALESCE(department, '')) <> ''
        GROUP BY LOWER(TRIM(department))`,
        params
    );

    const all = rows.map(withRate);
    const considered = all.filter((r) => r.total >= minTasks);

    return {
        success: true,
        filters: describeFilters(filters),
        access_scope: describeScope(profile),
        sorted_by: sortBy,
        order,
        min_tasks: minTasks,
        definitions:
            "Rates: completion_rate_percent = completed / total; on_time_rate_percent = on_time / completed. " +
            "Departments with fewer than min_tasks tasks are left out of the ranking (too few to judge). " +
            "Compare each department with 'overall' to say where improvement is needed.",
        overall: sumCounts(all),
        departments_ranked: sortRows(considered, sortBy, order).slice(0, 100),
        departments_left_out_small: all.length - considered.length
    };
};


// =====================================================================
// TOOL 11: Machines (equipment register, maintenance per machine, repairs)
// =====================================================================

const MACHINE_SORT = ["overdue", "pending", "late", "total", "on_time_rate", "completion_rate", "repairs"];

export const getMachineSummary = async (args, profile, { maxLimit = MAX_LIST_LIMIT } = {}) => {
    assertAdmin(profile);
    const { startDate, endDate, today, allTime } = resolveDateRange(args, { maxDays: Infinity });
    const machine = cleanText(args.machine_name);
    const department = cleanText(args.department);
    const sortBy = pickEnum(args.sort_by, MACHINE_SORT, "overdue", "sort_by");
    const order = pickEnum(args.order, ["worst_first", "best_first"], "worst_first", "order");
    const limit = clampLimit(args.limit, 15, maxLimit);

    // --- Equipment register + parts (not date based) ---
    const eParams = [];
    const eClauses = buildMachineScope(profile, eParams, "e");
    if (machine) {
        eParams.push(`%${escapeLike(machine)}%`);
        eClauses.push(`e.equipment_name ILIKE $${eParams.length}`);
    }
    if (department) {
        eParams.push(department);
        eClauses.push(`LOWER(TRIM(e.machine_department)) = LOWER(TRIM($${eParams.length}))`);
    }

    const pParams = [];
    const pClauses = buildMachineScope(profile, pParams, "p");
    if (machine) {
        pParams.push(`%${escapeLike(machine)}%`);
        pClauses.push(`p.machine_name ILIKE $${pParams.length}`);
    }
    if (department) {
        pParams.push(department);
        pClauses.push(`LOWER(TRIM(p.machine_department)) = LOWER(TRIM($${pParams.length}))`);
    }

    // --- Maintenance tasks per machine in the range (dates are UTC dates, like the dashboard) ---
    const mParams = [startDate, endDate, today];
    const mClauses = [
        "(t.status IS NULL OR LOWER(t.status::text) NOT IN ('leave', 'inactive'))",
        "(t.task_start_date AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date",
        "TRIM(COALESCE(t.machine_name, '')) <> ''",
        ...buildScope(profile, mParams, "t")
    ];
    if (machine) {
        mParams.push(`%${escapeLike(machine)}%`);
        mClauses.push(`t.machine_name ILIKE $${mParams.length}`);
    }
    if (department) {
        mParams.push(department);
        mClauses.push(`LOWER(TRIM(t.machine_department)) = LOWER(TRIM($${mParams.length}))`);
    }
    const onTime =
        "t.submission_date IS NOT NULL AND t.planned_date IS NOT NULL " +
        "AND (t.submission_date AT TIME ZONE 'UTC')::date <= (t.planned_date AT TIME ZONE 'UTC')::date";

    // --- Repairs per machine in the range (by created date, IST) ---
    const rParams = [startDate, endDate];
    const rClauses = [
        "(r.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date",
        ...buildMachineScope(profile, rParams, "r")
    ];
    if (machine) {
        rParams.push(`%${escapeLike(machine)}%`);
        rClauses.push(`r.machine_name ILIKE $${rParams.length}`);
    }
    if (department) {
        rParams.push(department);
        rClauses.push(`LOWER(TRIM(r.machine_department)) = LOWER(TRIM($${rParams.length}))`);
    }

    const [eqStatus, eqByDept, parts, maint, repairs] = await Promise.all([
        pool.query(
            `SELECT COALESCE(NULLIF(TRIM(e.status), ''), 'Unknown') AS status, COUNT(*)::int AS count
             FROM equipment_master e ${whereSql(eClauses)}
             GROUP BY 1 ORDER BY 2 DESC`,
            eParams
        ),
        pool.query(
            `SELECT TRIM(e.machine_division) AS division, TRIM(e.machine_department) AS department, COUNT(*)::int AS machines
             FROM equipment_master e ${whereSql(eClauses)}
             GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 30`,
            eParams
        ),
        pool.query(`SELECT COUNT(*)::int AS count FROM machine_parts p ${whereSql(pClauses)}`, pParams),
        pool.query(
            `SELECT
                MAX(TRIM(t.machine_name)) AS machine,
                MAX(TRIM(t.machine_department)) AS machine_department,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE t.submission_date IS NOT NULL)::int AS completed,
                COUNT(*) FILTER (WHERE t.submission_date IS NULL)::int AS pending,
                COUNT(*) FILTER (WHERE t.submission_date IS NULL AND (t.task_start_date AT TIME ZONE 'UTC')::date < $3::date)::int AS overdue,
                COUNT(*) FILTER (WHERE ${onTime})::int AS on_time,
                COUNT(*) FILTER (WHERE t.submission_date IS NOT NULL AND NOT COALESCE(${onTime}, FALSE))::int AS late,
                to_char(MAX(t.submission_date AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS last_maintenance_done
             FROM maintenance_tasks t
             WHERE ${mClauses.join(" AND ")}
             GROUP BY LOWER(TRIM(t.machine_name))`,
            mParams
        ),
        pool.query(
            `SELECT LOWER(TRIM(COALESCE(r.machine_name, ''))) AS k,
                    MAX(TRIM(r.machine_name)) AS machine,
                    COALESCE(NULLIF(TRIM(r.status), ''), 'Unknown') AS status,
                    COUNT(*)::int AS count
             FROM repair_tasks r
             WHERE ${rClauses.join(" AND ")}
             GROUP BY 1, 3`,
            rParams
        )
    ]);

    // Repairs per machine (all statuses) to attach to the maintenance rows.
    const repairByMachine = new Map();
    const repairByStatus = new Map();
    for (const r of repairs.rows) {
        repairByMachine.set(r.k, (repairByMachine.get(r.k) || 0) + r.count);
        repairByStatus.set(r.status, (repairByStatus.get(r.status) || 0) + r.count);
    }

    const machines = maint.rows.map((m) => ({
        ...withRate(m),
        repairs: repairByMachine.get(String(m.machine || "").toLowerCase()) || 0
    }));

    return {
        success: true,
        filters: {
            ...(allTime ? { all_time: true } : {}),
            start_date: startDate,
            end_date: endDate,
            machine: machine || "all",
            department: department || "all",
            sorted_by: sortBy,
            order
        },
        access_scope: describeScope(profile),
        definitions:
            "equipment_* = machine register (not date based). maintenance_* = maintenance tasks dated in the range, per machine; " +
            "on_time = submitted on or before the planned date. repairs = repair tasks created in the range.",
        equipment_registered: eqStatus.rows.reduce((n, r) => n + r.count, 0),
        equipment_by_status: eqStatus.rows,
        equipment_by_department: eqByDept.rows,
        machine_parts_registered: parts.rows[0].count,
        maintenance_overall: sumCounts(maint.rows),
        machines_with_maintenance: machines.length,
        machines_ranked: sortRows(machines, sortBy, order).slice(0, limit).map(compactRow),
        repairs_total: repairs.rows.reduce((n, r) => n + r.count, 0),
        repairs_by_status: [...repairByStatus].map(([status, count]) => ({ status, count }))
    };
};


// =====================================================================
// TOOL 12: Machine details (register info, parts, part-wise maintenance,
//          recent maintenance tasks, repair history)
// =====================================================================

const TASK_STATUS_FILTERS = ["all", "pending", "overdue", "completed", "on_time", "late"];

export const getMachineDetails = async (args, profile, { maxLimit = MAX_LIST_LIMIT } = {}) => {
    assertAdmin(profile);
    const { startDate, endDate, today, allTime } = resolveDateRange(args, { maxDays: Infinity });
    const machine = cleanText(args.machine_name);
    const part = cleanText(args.part_name);
    const area = cleanText(args.part_area);
    const department = cleanText(args.department);
    const division = cleanText(args.division);
    const taskStatus = pickEnum(args.task_status, TASK_STATUS_FILTERS, "all", "task_status");
    const taskLimit = clampLimit(args.limit, 10, maxLimit);

    if (!machine && !part && !area && !department && !division) {
        throw new Error(
            "Provide a machine_name, part_name, part_area, department or division. " +
            "For overall machine counts use get_machine_summary."
        );
    }

    const like = (v) => `%${escapeLike(v)}%`;

    // ---- Equipment register (equipment_master) ----
    const eParams = [];
    const eClauses = buildMachineScope(profile, eParams, "e");
    if (machine) { eParams.push(like(machine)); eClauses.push(`(e.equipment_name ILIKE $${eParams.length} OR e.equipment_id ILIKE $${eParams.length})`); }
    if (area) { eParams.push(like(area)); eClauses.push(`e.machine_area ILIKE $${eParams.length}`); }
    if (part) {
        // Machines whose registered parts include this part.
        eParams.push(like(part));
        eClauses.push(`EXISTS (
            SELECT 1 FROM machine_parts p2, UNNEST(p2.part_name) x
            WHERE (p2.equipment_id = e.equipment_id OR LOWER(TRIM(p2.machine_name)) = LOWER(TRIM(e.equipment_name)))
              AND x ILIKE $${eParams.length})`);
    }
    if (department) { eParams.push(department); eClauses.push(`LOWER(TRIM(e.machine_department)) = LOWER(TRIM($${eParams.length}))`); }
    if (division) { eParams.push(division); eClauses.push(`LOWER(TRIM(e.machine_division)) = LOWER(TRIM($${eParams.length}))`); }

    // ---- Registered parts (machine_parts: one row per machine + area, part_name[]) ----
    const pParams = [];
    const pClauses = buildMachineScope(profile, pParams, "p");
    if (machine) { pParams.push(like(machine)); pClauses.push(`(p.machine_name ILIKE $${pParams.length} OR p.equipment_id ILIKE $${pParams.length})`); }
    if (area) { pParams.push(like(area)); pClauses.push(`p.machine_area ILIKE $${pParams.length}`); }
    if (part) { pParams.push(like(part)); pClauses.push(`EXISTS (SELECT 1 FROM UNNEST(p.part_name) x WHERE x ILIKE $${pParams.length})`); }
    if (department) { pParams.push(department); pClauses.push(`LOWER(TRIM(p.machine_department)) = LOWER(TRIM($${pParams.length}))`); }
    if (division) { pParams.push(division); pClauses.push(`LOWER(TRIM(p.machine_division)) = LOWER(TRIM($${pParams.length}))`); }

    // ---- Maintenance tasks in the range (UTC dates, like the dashboard) ----
    const mParams = [startDate, endDate, today];
    const mClauses = [
        "(t.status IS NULL OR LOWER(t.status::text) NOT IN ('leave', 'inactive'))",
        "(t.task_start_date AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date",
        ...buildScope(profile, mParams, "t")
    ];
    if (machine) { mParams.push(like(machine)); mClauses.push(`t.machine_name ILIKE $${mParams.length}`); }
    if (area) { mParams.push(like(area)); mClauses.push(`t.part_area ILIKE $${mParams.length}`); }
    if (part) { mParams.push(like(part)); mClauses.push(`EXISTS (SELECT 1 FROM UNNEST(t.part_name) x WHERE x ILIKE $${mParams.length})`); }
    if (department) { mParams.push(department); mClauses.push(`LOWER(TRIM(t.machine_department)) = LOWER(TRIM($${mParams.length}))`); }
    if (division) { mParams.push(division); mClauses.push(`LOWER(TRIM(t.machine_division)) = LOWER(TRIM($${mParams.length}))`); }

    const onTime =
        "t.submission_date IS NOT NULL AND t.planned_date IS NOT NULL " +
        "AND (t.submission_date AT TIME ZONE 'UTC')::date <= (t.planned_date AT TIME ZONE 'UTC')::date";
    const overdue = "t.submission_date IS NULL AND (t.task_start_date AT TIME ZONE 'UTC')::date < $3::date";
    const statusSql = {
        all: "TRUE",
        pending: "t.submission_date IS NULL",
        overdue,
        completed: "t.submission_date IS NOT NULL",
        on_time: onTime,
        late: `t.submission_date IS NOT NULL AND NOT COALESCE(${onTime}, FALSE)`
    }[taskStatus];
    const mWhere = mClauses.join(" AND ");

    // ---- Repair history (all time, latest first) ----
    const rParams = [];
    const rClauses = buildMachineScope(profile, rParams, "r");
    if (machine) { rParams.push(like(machine)); rClauses.push(`(r.machine_name ILIKE $${rParams.length} OR r.equipment_id ILIKE $${rParams.length})`); }
    if (part) { rParams.push(like(part)); rClauses.push(`r.part_replaced ILIKE $${rParams.length}`); }
    if (area) {
        // Repairs on machines located in this area (repair_tasks has no area column).
        rParams.push(like(area));
        rClauses.push(`EXISTS (
            SELECT 1 FROM machine_parts p2
            WHERE p2.machine_area ILIKE $${rParams.length}
              AND (p2.equipment_id = r.equipment_id OR LOWER(TRIM(p2.machine_name)) = LOWER(TRIM(r.machine_name)))
            UNION ALL
            SELECT 1 FROM equipment_master e2
            WHERE e2.machine_area ILIKE $${rParams.length}
              AND (e2.equipment_id = r.equipment_id OR LOWER(TRIM(e2.equipment_name)) = LOWER(TRIM(r.machine_name))))`);
    }
    if (department) { rParams.push(department); rClauses.push(`LOWER(TRIM(r.machine_department)) = LOWER(TRIM($${rParams.length}))`); }
    if (division) { rParams.push(division); rClauses.push(`LOWER(TRIM(r.machine_division)) = LOWER(TRIM($${rParams.length}))`); }

    const [equipment, parts, partStats, tasks, repairs] = await Promise.all([
        pool.query(
            `SELECT e.equipment_id, e.equipment_name, e.model, e.serial_no,
                    e.machine_division AS division, e.machine_department AS department, e.machine_area AS area,
                    to_char(e.purchase_date, 'YYYY-MM-DD') AS purchase_date,
                    to_char(e.installation_date, 'YYYY-MM-DD') AS installation_date,
                    e.running_hours, e.status, e.remarks,
                    COUNT(*) OVER ()::int AS total_matching
             FROM equipment_master e ${whereSql(eClauses)}
             ORDER BY e.equipment_name
             LIMIT 20`,
            eParams
        ),
        pool.query(
            `SELECT p.machine_name, p.machine_area AS area, p.machine_department AS department,
                    p.machine_division AS division, p.equipment_id,
                    COALESCE(CARDINALITY(p.part_name), 0)::int AS part_count,
                    LEFT(ARRAY_TO_STRING(p.part_name, ', '), 400) AS parts,
                    COUNT(*) OVER ()::int AS total_matching,
                    SUM(COALESCE(CARDINALITY(p.part_name), 0)) OVER ()::int AS total_parts
             FROM machine_parts p ${whereSql(pClauses)}
             ORDER BY p.machine_name, p.machine_area
             LIMIT 20`,
            pParams
        ),
        // Part-wise: a task covering several parts counts once for each part.
        pool.query(
            `SELECT MAX(TRIM(x)) AS part,
                    MAX(TRIM(t.machine_name)) AS machine,
                    MAX(TRIM(t.part_area)) AS area,
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE t.submission_date IS NOT NULL)::int AS completed,
                    COUNT(*) FILTER (WHERE t.submission_date IS NULL)::int AS pending,
                    COUNT(*) FILTER (WHERE ${overdue})::int AS overdue,
                    COUNT(*) FILTER (WHERE ${onTime})::int AS on_time,
                    COUNT(*) FILTER (WHERE t.submission_date IS NOT NULL AND NOT COALESCE(${onTime}, FALSE))::int AS late,
                    to_char(MAX(t.submission_date AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS last_done
             FROM maintenance_tasks t, UNNEST(t.part_name) AS x
             WHERE ${mWhere} AND TRIM(COALESCE(x, '')) <> ''
             GROUP BY LOWER(TRIM(x))
             ORDER BY overdue DESC, pending DESC, total DESC
             LIMIT 30`,
            mParams
        ),
        pool.query(
            `SELECT t.id::text AS task_id,
                    TRIM(t.machine_name) AS machine,
                    LEFT(ARRAY_TO_STRING(t.part_name, ', '), 150) AS parts,
                    t.part_area AS area,
                    TRIM(t.name) AS doer,
                    t.given_by AS assigned_by,
                    LEFT(t.task_description, 200) AS task_description,
                    t.frequency,
                    to_char((t.task_start_date AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS task_date,
                    to_char(t.submission_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS submitted_at,
                    CASE
                        WHEN t.submission_date IS NOT NULL THEN
                            CASE WHEN ${onTime} THEN 'completed_on_time' ELSE 'completed_late' END
                        WHEN ${overdue} THEN 'overdue'
                        WHEN (t.task_start_date AT TIME ZONE 'UTC')::date = $3::date THEN 'due_today'
                        ELSE 'upcoming'
                    END AS current_status,
                    t.duration, t.manpower, t.remarks, t.admin_done AS approval,
                    COUNT(*) OVER ()::int AS total_matching,
                    COUNT(*) FILTER (WHERE t.submission_date IS NULL) OVER ()::int AS pending_total,
                    COUNT(*) FILTER (WHERE ${overdue}) OVER ()::int AS overdue_total
             FROM maintenance_tasks t
             WHERE ${mWhere} AND ${statusSql}
             ORDER BY (t.submission_date IS NULL) DESC, t.task_start_date DESC
             LIMIT $${mParams.length + 1}`,
            [...mParams, taskLimit]
        ),
        pool.query(
            `SELECT to_char(r.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS reported_on,
                    r.machine_name AS machine, r.equipment_id, r.issue_description AS issue,
                    r.part_replaced, r.status, r.assigned_person, r.filled_by AS reported_by,
                    r.vendor_name AS vendor, r.bill_amount, r.duration,
                    to_char(r.submission_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS completed_on,
                    r.admin_approved_by AS approved_by,
                    COUNT(*) OVER ()::int AS total_matching
             FROM repair_tasks r ${whereSql(rClauses)}
             ORDER BY r.created_at DESC
             LIMIT 10`,
            rParams
        )
    ]);

    const total = (res) => res.rows[0]?.total_matching || 0;
    const strip = (rows, keys) => rows.map((r) => {
        const copy = { ...r };
        for (const k of keys) delete copy[k];
        return compactRow(copy);
    });
    const firstTask = tasks.rows[0] || {};

    return {
        success: true,
        filters: {
            ...(allTime ? { all_time: true } : {}),
            start_date: startDate,
            end_date: endDate,
            machine: machine || "any",
            part: part || "any",
            part_area: area || "any",
            department: department || "any",
            division: division || "any",
            task_status: taskStatus
        },
        access_scope: describeScope(profile),
        definitions:
            "equipment = machine register (model, serial no, dates, running hours). registered_parts = parts list per machine + area. " +
            "part_wise_maintenance and maintenance_tasks cover tasks dated in the range; a task covering several parts counts once per part " +
            "in part_wise_maintenance. repair_history is all time (latest 10).",
        equipment: { total_matching: total(equipment), rows: strip(equipment.rows, ["total_matching"]) },
        registered_parts: {
            machine_area_rows: total(parts),
            total_parts: parts.rows[0]?.total_parts || 0,
            rows: strip(parts.rows, ["total_matching", "total_parts"])
        },
        part_wise_maintenance: partStats.rows.map(compactRow),
        maintenance_tasks: {
            total_matching: firstTask.total_matching || 0,
            pending: firstTask.pending_total || 0,
            overdue: firstTask.overdue_total || 0,
            showing: tasks.rows.length,
            rows: strip(tasks.rows, ["total_matching", "pending_total", "overdue_total"])
        },
        repair_history: { total: total(repairs), rows: strip(repairs.rows, ["total_matching"]) }
    };
};

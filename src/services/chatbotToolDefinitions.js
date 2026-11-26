export const employeeTools = [
    {
        type: "function",
        function: {
            name: "get_my_tasks",
            description:
                "Retrieve the authenticated employee's assigned tasks. Use this when the employee asks about their tasks, pending work, or completed work.",
            parameters: {
                type: "object",
                properties: {
                    status: {
                        type: "string",
                        enum: ["all", "pending", "completed", "other"],
                        description: "Task status filter."
                    }
                },
                required: ["status"],
                additionalProperties: false
            }
        }
    },

    {
        type: "function",
        function: {
            name: "get_my_work_history",
            description:
                "Retrieve the authenticated employee's previously submitted daily work reports. Use date for a specific date. Use start_date and end_date together for a date range, such as the last 7 days. If no date or range is specified, retrieve recent work history. Never provide null values. Do not combine a specific date with a date range.",
            parameters: {
                type: "object",
                properties: {
                    date: {
                        type: "string",
                        description:
                            "Optional specific date in YYYY-MM-DD format."
                    },
                    start_date: {
                        type: "string",
                        description:
                            "Optional inclusive start date in YYYY-MM-DD format. Must be provided together with end_date."
                    },
                    end_date: {
                        type: "string",
                        description:
                            "Optional inclusive end date in YYYY-MM-DD format. Must be provided together with start_date."
                    }
                },
                required: [],
                additionalProperties: false
            }
        }
    },

    {
        type: "function",
        function: {
            name: "submit_my_work_report",
            description:
                "PREPARE a daily work report for the authenticated employee. Call this tool when the employee asks to prepare, submit, or record a work report. Collect work_details, status, and duration. This tool ONLY prepares a pending report and generates a confirmation token. It DOES NOT insert anything into the database. After calling this tool, present the report details and ask the employee for explicit confirmation. Never claim the report has been submitted. Actual database insertion happens separately through the backend confirmation API.",
            parameters: {
                type: "object",
                properties: {
                    work_details: {
                        type: "string",
                        description: "Description of work performed."
                    },
                    status: {
                        type: "string",
                        enum: ["Completed", "In Progress", "Pending"],
                        description: "Employee-reported work status."
                    },
                    duration: {
                        type: "string",
                        description: "Time spent on the work, such as 2 hours."
                    }
                },
                required: [
                    "work_details",
                    "status",
                    "duration"
                ],
                additionalProperties: false
            }
        }
    }
];

// =====================================================================
// ADMIN (READ-ONLY) DATA TOOLS
// Available only to super_admin / div_admin / admin. Executed by
// chatbotDataService.js on a read-only database connection.
// =====================================================================

const dateRangeProps = {
    start_date: {
        type: "string",
        description:
            "Inclusive start date, YYYY-MM-DD. Default: first day of the current month. For 'today' use today's date; for 'last 7 days / past week' use today minus 6 days."
    },
    end_date: {
        type: "string",
        description: "Inclusive end date, YYYY-MM-DD. Default: today."
    }
};

// Only on count / summary tools (cheap over long periods).
const allTimeProp = {
    all_time: {
        type: "boolean",
        description:
            "true for 'all time / shuru se ab tak / ab tak total / overall since the beginning'. Ignores start_date and end_date."
    }
};

const taskTypeProp = {
    task_type: {
        type: "string",
        enum: ["all", "checklist", "delegation", "maintenance"],
        description: "Which task system to read. Default 'all'."
    }
};

const orgFilterProps = {
    department: {
        type: "string",
        description: "Optional exact department name (use list_departments if unsure of the spelling)."
    },
    unit: {
        type: "string",
        description: "Optional unit / company name, e.g. 'RAMA UDYOG' (super admin only)."
    },
    division: {
        type: "string",
        description: "Optional division name (super admin only)."
    }
};

export const adminTools = [
    {
        type: "function",
        function: {
            name: "get_task_summary",
            description:
                "Get task COUNTS (total, completed, pending, overdue, due_today, not_done, on_time, late, extended, completion rate, on-time rate) for the whole organisation, a department, or one employee, over a date range. Numbers follow the dashboard rules. Use for questions like 'total tasks kitne hain', 'kitne complete hue', 'on time kitne hue', 'on time percentage', 'Rahul ke kitne pending hain'.",
            parameters: {
                type: "object",
                properties: {
                    ...taskTypeProp,
                    ...dateRangeProps,
                    ...allTimeProp,
                    employee_name: {
                        type: "string",
                        description: "Optional employee name (full or partial)."
                    },
                    ...orgFilterProps
                },
                required: [],
                additionalProperties: false
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_employee_wise_summary",
            description:
                "Get task counts PER EMPLOYEE, ranked. Use for 'kis employee ke sabse zyada pending/overdue hain', 'top performers', 'department ke employees ka status'.",
            parameters: {
                type: "object",
                properties: {
                    ...taskTypeProp,
                    ...dateRangeProps,
                    ...allTimeProp,
                    ...orgFilterProps,
                    sort_by: {
                        type: "string",
                        enum: ["pending", "overdue", "completed", "total", "completion_rate", "on_time", "late", "extended"],
                        description: "Ranking field. Default 'pending'."
                    },
                    limit: {
                        type: "integer",
                        description: "Number of employees to return (1-50). Default 15."
                    }
                },
                required: [],
                additionalProperties: false
            }
        }
    },
    {
        type: "function",
        function: {
            name: "list_tasks",
            description:
                "List INDIVIDUAL tasks with full details: description, employee, department, given_by, frequency, task date, planned date, submitted at, status, on_time/late, delay, times extended, remarks, approval, submitted_by, approved_by, machine (maintenance). Use when the user wants to see which tasks, e.g. 'Rahul ke pending tasks dikhao', 'aaj ke overdue tasks', 'late complete hue tasks', 'delay kitna tha'.",
            parameters: {
                type: "object",
                properties: {
                    ...taskTypeProp,
                    ...dateRangeProps,
                    employee_name: {
                        type: "string",
                        description: "Optional employee name (full or partial)."
                    },
                    ...orgFilterProps,
                    status: {
                        type: "string",
                        enum: ["all", "pending", "overdue", "due_today", "completed", "not_done", "on_time", "late", "extended"],
                        description: "Task status filter. Default 'pending'. on_time / late = completed on time / late. extended = delegation tasks extended at least once."
                    },
                    limit: {
                        type: "integer",
                        description: "Max tasks to return (1-50). Default 20."
                    }
                },
                required: [],
                additionalProperties: false
            }
        }
    },
    {
        type: "function",
        function: {
            name: "find_employees",
            description:
                "Search employees by (partial) name and/or department. Use to resolve which employee the user means or to list a department's staff.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Part of the employee's name."
                    },
                    department: {
                        type: "string",
                        description: "Optional exact department name."
                    },
                    limit: {
                        type: "integer",
                        description: "Rows to return (default 50, max 100)."
                    }
                },
                required: [],
                additionalProperties: false
            }
        }
    },
    {
        type: "function",
        function: {
            name: "list_departments",
            description:
                "List departments (with unit, division and active employee count) the user can access.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false
            }
        }
    },
    {
        type: "function",
        function: {
            name: "list_extended_delegations",
            description:
                "List delegation tasks that were EXTENDED (deadline extension requested), with how many times, extended-to date, reason, current planned date and current status. The date range filters by the date the extension was requested. Use for 'extend wale tasks', 'extended delegation', 'kis task ki date badhi', 'kitne tasks extend hue'.",
            parameters: {
                type: "object",
                properties: {
                    ...dateRangeProps,
                    ...allTimeProp,
                    employee_name: {
                        type: "string",
                        description: "Optional employee name (full or partial)."
                    },
                    ...orgFilterProps,
                    status: {
                        type: "string",
                        enum: ["all", "pending", "completed"],
                        description: "Current state of the extended task. Default 'all'."
                    },
                    limit: {
                        type: "integer",
                        description: "Max tasks to return (1-50). Default 20."
                    }
                },
                required: [],
                additionalProperties: false
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_work_reports",
            description:
                "Get employees' DAILY WORK REPORTS (working_date_history) over a date range: summary counts (total, employees reporting, completed / in progress / pending) and the report list (date-time, employee, work details, status, duration, assigned by). Use for 'kisne kya kaam kiya', 'work reports dikhao', 'Rahul ki daily report', 'aaj kitne logon ne report bhari'.",
            parameters: {
                type: "object",
                properties: {
                    ...dateRangeProps,
                    ...allTimeProp,
                    employee_name: {
                        type: "string",
                        description: "Optional employee name (full or partial)."
                    },
                    ...orgFilterProps,
                    status: {
                        type: "string",
                        enum: ["all", "completed", "in progress", "pending"],
                        description: "Report status filter. Default 'all'."
                    },
                    limit: {
                        type: "integer",
                        description: "Max reports to return (1-50). Default 20."
                    }
                },
                required: [],
                additionalProperties: false
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_system_overview",
            description:
                "One-shot overview of the whole system within the user's access: how many people (active / inactive / on leave), how many employees, admins, division admins and super admins, how many units / divisions / departments, how many machines (equipment register, machine parts, machines with maintenance tasks), repair tasks, and all-time task totals per type (checklist / delegation / maintenance) with completion and on-time %. Use for 'kitna aadmi hai', 'kitne admin hain', 'kitne department hain', 'kitni machine hain', 'system ke baare mein batao', 'overall status', 'total kitne tasks bane ab tak'.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false
            }
        }
    },
    {
        type: "function",
        function: {
            name: "list_employees_without_tasks",
            description:
                "Active people who have NO task (checklist / delegation / maintenance) assigned in a period, with a department-wise count and each person's last task date ('never' = no task ever). Use for 'kitne aadmi ka task bana hi nahi', 'kiska koi task nahi hai', 'idle employees', 'jinko kaam assign nahi hua'.",
            parameters: {
                type: "object",
                properties: {
                    ...taskTypeProp,
                    ...dateRangeProps,
                    ...allTimeProp,
                    department: orgFilterProps.department,
                    role: {
                        type: "string",
                        enum: ["user", "admins", "all"],
                        description: "Whose accounts to check. Default 'user' (regular employees). 'admins' = admin / div_admin / super_admin."
                    },
                    limit: {
                        type: "integer",
                        description: "Max people to list (1-50). Default 50. Counts always cover everyone."
                    }
                },
                required: [],
                additionalProperties: false
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_department_wise_summary",
            description:
                "Task performance PER DEPARTMENT, ranked (default: worst on-time % first), with the overall figures for comparison: total, completed, pending, overdue, on time, late, completion % and on-time %. Use for 'kahan improve karne ki zarurat hai', 'kaunsa department peeche hai', 'best / worst department', 'department wise performance'.",
            parameters: {
                type: "object",
                properties: {
                    ...taskTypeProp,
                    ...dateRangeProps,
                    ...allTimeProp,
                    unit: orgFilterProps.unit,
                    division: orgFilterProps.division,
                    sort_by: {
                        type: "string",
                        enum: ["on_time_rate", "completion_rate", "overdue", "pending", "late", "not_done", "total"],
                        description: "Ranking metric. Default 'on_time_rate'."
                    },
                    order: {
                        type: "string",
                        enum: ["worst_first", "best_first"],
                        description: "Default 'worst_first' (needs improvement first)."
                    },
                    min_tasks: {
                        type: "integer",
                        description: "Ignore departments with fewer tasks than this in the period. Default 5."
                    }
                },
                required: [],
                additionalProperties: false
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_machine_summary",
            description:
                "Machines: equipment register count (by status and department), machine parts registered, and maintenance performance PER MACHINE in a period (total, completed, pending, overdue, on time, late, last maintenance done, repairs), ranked; plus repair tasks by status. Use for 'kitni machine hain', 'kis machine ka maintenance pending hai', 'sabse zyada overdue kis machine par', 'machine repair status'.",
            parameters: {
                type: "object",
                properties: {
                    ...dateRangeProps,
                    ...allTimeProp,
                    machine_name: {
                        type: "string",
                        description: "Optional machine name (full or partial)."
                    },
                    department: {
                        type: "string",
                        description: "Optional machine department (e.g. 'Mechanical')."
                    },
                    sort_by: {
                        type: "string",
                        enum: ["overdue", "pending", "late", "total", "on_time_rate", "completion_rate", "repairs"],
                        description: "Ranking metric for machines. Default 'overdue'."
                    },
                    order: {
                        type: "string",
                        enum: ["worst_first", "best_first"],
                        description: "Default 'worst_first'."
                    },
                    limit: {
                        type: "integer",
                        description: "Machines to list (1-50). Default 15."
                    }
                },
                required: [],
                additionalProperties: false
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_machine_details",
            description:
                "Full details for ONE machine, part, part area, machine department or division: equipment register info (equipment ID, model, serial no, purchase / installation date, running hours, status), registered parts list, PART-WISE maintenance status (total, pending, overdue, on time, late, last done), recent maintenance tasks (parts, area, doer, assigned by, description, frequency, status, duration, manpower, remarks, approval) and repair history (issue, part replaced, vendor, bill amount, status). Use for 'STG machine ki detail', 'STG ke kaun se parts hain', 'turbine area ke pending maintenance', 'generator part ka status', 'is machine ki repair history'.",
            parameters: {
                type: "object",
                properties: {
                    machine_name: {
                        type: "string",
                        description: "Machine name or equipment ID (full or partial), e.g. 'STG'."
                    },
                    part_name: {
                        type: "string",
                        description: "Part name (full or partial), e.g. 'TURBINE'."
                    },
                    part_area: {
                        type: "string",
                        description: "Part / machine area (full or partial), e.g. 'TURBINE AREA'."
                    },
                    department: {
                        type: "string",
                        description: "Machine department, e.g. 'Electrical'."
                    },
                    division: {
                        type: "string",
                        description: "Machine division, e.g. 'CPP'."
                    },
                    ...dateRangeProps,
                    ...allTimeProp,
                    task_status: {
                        type: "string",
                        enum: ["all", "pending", "overdue", "completed", "on_time", "late"],
                        description: "Filter for the maintenance task list. Default 'all'."
                    },
                    limit: {
                        type: "integer",
                        description: "Maintenance tasks to list (1-50). Default 10."
                    }
                },
                required: [],
                additionalProperties: false
            }
        }
    }
];

export const ADMIN_TOOL_NAMES = adminTools.map((tool) => tool.function.name);

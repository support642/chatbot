// Must run after chatbotAdminMiddleware (which loads the role from the database
// into req.admin). Only super_admin may manage settings such as the OpenAI key.
const superAdminMiddleware = (req, res, next) => {
    if (req.admin?.role !== "super_admin") {
        return res.status(403).json({
            success: false,
            message: "Only a super admin can manage AI settings."
        });
    }

    next();
};

export default superAdminMiddleware;

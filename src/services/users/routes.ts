import { Router } from "express"
import { userAvatarUpload } from "../../settings/cloudinary"
import { isAdministrator, JWTAuthMiddleware } from "../auth/middlewares"
import { peopleAddedLimit } from "../../middlewares/rateLimits"
import * as controllers from "./controllers"
import { validate } from "../../middlewares/validate"
import { createUserSchema, deleteMeSchema, editMeSchema, listUsersSchema, setRoleSchema } from "./schemas"

const router = Router()

// Me Routes
router.get("/me", JWTAuthMiddleware, controllers.getMe)
router.put("/me", JWTAuthMiddleware, validate(editMeSchema), controllers.editMe)
router.put("/me/avatar", JWTAuthMiddleware, userAvatarUpload, controllers.editMyAvatar)
router.delete("/me", JWTAuthMiddleware, validate(deleteMeSchema), controllers.deleteMe)

// An administrator's account routes. After the "/me" routes, which would
// otherwise be taken for a userId.
router.get("/", JWTAuthMiddleware, isAdministrator, validate(listUsersSchema, "query"), controllers.listUsers)
router.post("/", JWTAuthMiddleware, isAdministrator, peopleAddedLimit, validate(createUserSchema), controllers.createUser)
router.put("/:userId/role", JWTAuthMiddleware, isAdministrator, validate(setRoleSchema), controllers.setRole)
router.delete("/:userId", JWTAuthMiddleware, isAdministrator, controllers.deleteUser)

export default router
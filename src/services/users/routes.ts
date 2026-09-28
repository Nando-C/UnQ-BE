import { Router } from "express"
import { userAvatarUpload } from "../../settings/cloudinary"
import { JWTAuthMiddleware } from "../auth/middlewares"
import * as controllers from "./controllers"
import { validate } from "../../middlewares/validate"
import { editMeSchema } from "./schemas"

const router = Router()

// Me Routes
router.get("/me", JWTAuthMiddleware, controllers.getMe)
router.put("/me", JWTAuthMiddleware, validate(editMeSchema), controllers.editMe)
router.put("/me/avatar", JWTAuthMiddleware, userAvatarUpload, controllers.editMyAvatar)
router.delete("/me", JWTAuthMiddleware, controllers.deleteMe)

export default router
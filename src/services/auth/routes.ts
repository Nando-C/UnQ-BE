import { Router } from "express"
import passport from "passport"
import * as controllers from "./controllers"
import { JWTAuthMiddleware } from "./middlewares"
import { validate } from "../../middlewares/validate"
import { registerSchema, loginSchema } from "./schemas"

const router = Router()

router
    .post("/refreshToken", controllers.tokenRefresh)
    .post("/register", validate(registerSchema), controllers.registerUser)
    .post("/login", validate(loginSchema), controllers.loginUser)
    .get("/logout", JWTAuthMiddleware, controllers.logoutUser)
    .get("/googleLogin", passport.authenticate("google", { scope: [ "profile", "email"], session: false }))
    .get("/googleRedirect", passport.authenticate("google", { session: false }), controllers.googleRedirect)

export default router
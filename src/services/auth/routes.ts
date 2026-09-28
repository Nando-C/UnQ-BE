import { Router } from "express"
import passport from "passport"
import * as controllers from "./controllers"
import { JWTAuthMiddleware } from "./middlewares"
import { validate } from "../../middlewares/validate"
import { registerSchema, loginSchema } from "./schemas"
import env from "../../settings/env"

const router = Router()

router
    .post("/refreshToken", controllers.tokenRefresh)
    .post("/register", validate(registerSchema), controllers.registerUser)
    .post("/login", validate(loginSchema), controllers.loginUser)
    .get("/logout", JWTAuthMiddleware, controllers.logoutUser)
    .get("/googleLogin", passport.authenticate("google", { scope: [ "profile", "email"], session: false }))
    // A sign-in Google vouches for but that can't be matched to an account
    // safely (see googleUserFor) goes back to the login page, not an error page.
    .get("/googleRedirect", passport.authenticate("google", { session: false, failureRedirect: `${env.FRONTEND_ORIGIN}/login` }), controllers.googleRedirect)

export default router
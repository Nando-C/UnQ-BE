import { Router } from "express"
import passport from "passport"
import * as controllers from "./controllers"

const router = Router()

router
    .post("/refreshToken", controllers.tokenRefresh)
    .post("/register", controllers.registerUser)
    .post("/login", controllers.loginUser)
    .get("/logout", controllers.logoutUser)
    .get("/googleLogin", passport.authenticate("google", { scope: [ "profile", "email"]}))
    .get("/googleRedirect", passport.authenticate("google"), controllers.googleRedirect)

export default router
import { Router } from "express"
import * as controllers from "./controllers"

const router = Router()

router
    .post("/register", controllers.registerUser)
    .post("/login", controllers.loginUser)
    .post("/refreshToken", controllers.refresh)

export default router
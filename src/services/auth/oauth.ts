import passport from "passport"
import GoogleStrategy from "passport-google-oauth20"
import UserModel from "../users/model"
import { getTokens } from "./tools"
import dotenv from 'dotenv'
dotenv.config()

const googleStrategy = new GoogleStrategy.Strategy(
    {
        clientID: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_SECRET!,
        callbackURL: `${process.env.BACKEND_URL}/auth/googleRedirect`
    },

    async(accessToken, refreshToken, profile, passportNext) => {
        try {
            const user = await UserModel.findOne({googleId: profile.id})

            if (user) {
                const tokens = await getTokens(user)
                passportNext(null, {tokens})
                
            } else {
                const newUser = {
                    name: profile.name?.givenName,
                    surname: profile.name?.familyName,
                    email: profile.emails![0].value,  // double check typings here
                    avatar: profile.photos![0].value, // double check typings here
                    googleId: profile.id,
                }
                
                const createdUser = new UserModel(newUser)
                const savedUser = await createdUser.save()
                const tokens = await getTokens(savedUser)

                passportNext(null, {user: savedUser, tokens})
            }
            
        } catch (error) { 
            console.log(error)
            passportNext(error as Error)
        }
    }
)

passport.serializeUser(function (user, passportNext) {
    passportNext(null, user)
})

export default googleStrategy
import GoogleStrategy from "passport-google-oauth20"
import UserModel from "../users/model"
import { getTokens } from "./tools"
import env from "../../settings/env"

const googleStrategy = new GoogleStrategy.Strategy(
    {
        clientID: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_SECRET,
        // Where a BROWSER reaches this API, which is not necessarily this server's own
        // origin: Google redirects the user here, so when the front-end proxies the API
        // through its own origin this must be that proxied prefix (e.g. https://…/api),
        // or the auth cookies get set on a domain the front-end can never read.
        callbackURL: `${env.PUBLIC_API_URL}/auth/googleRedirect`
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

export default googleStrategy
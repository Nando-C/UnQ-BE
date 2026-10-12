import GoogleStrategy from "passport-google-oauth20"
import UserModel from "../users/model"
import { deviceOf, getTokens } from "./tools"
import env from "../../settings/env"

const googleStrategy = new GoogleStrategy.Strategy(
    {
        clientID: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_SECRET,
        // Google sends the browser back here: see PUBLIC_API_URL in settings/env.ts.
        callbackURL: `${env.PUBLIC_API_URL}/auth/googleRedirect`,
        // The request, for the device the session remembers.
        passReqToCallback: true,
    },

    async(req, accessToken, refreshToken, profile, passportNext) => {
        try {
            const user = await googleUserFor(profile)
            // Nobody to sign in: passport answers with the route's failureRedirect.
            if (!user) return passportNext(null, false)

            const tokens = await getTokens(user, deviceOf(req))
            passportNext(null, {user, tokens})
        } catch (error) { 
            console.log(error)
            passportNext(error as Error)
        }
    }
)

// The account a Google sign-in belongs to. Already linked: found by googleId.
// Otherwise an account with the same email (registered with a password) is
// linked to this Google account rather than duplicated (emails are unique).
// Linking trusts Google's word that the address is the user's own, so only a
// verified email links; an unverified one that matches an account gets no
// sign-in (null), as does a profile with no email at all. A new email gets a
// new account.
// Linking also removes the account's password: nothing proved whoever set it
// owned the address (anyone can register with someone else's email and wait
// for them to sign in with Google), so from now on only Google signs in.
export const googleUserFor = async (profile: GoogleStrategy.Profile) => {
    const linked = await UserModel.findOne({googleId: profile.id})
    if (linked) return linked

    const email = profile.emails?.[0]
    if (!email?.value) return null

    const existing = await UserModel.findOne({email: email.value})
    if (existing) {
        if (!email.verified) return null
        existing.googleId = profile.id
        existing.password = undefined
        if (!existing.avatar) existing.avatar = profile.photos?.[0]?.value
        return existing.save()
    }

    // Google may have no family name (or given name) for the account: the
    // name falls back to the display name or the email's local part, and the
    // surname is left out (only required of accounts that registered).
    return new UserModel({
        name: profile.name?.givenName || profile.displayName || email.value.split("@")[0],
        surname: profile.name?.familyName || undefined,
        email: email.value,
        avatar: profile.photos?.[0]?.value,
        googleId: profile.id,
    }).save()
}

export default googleStrategy
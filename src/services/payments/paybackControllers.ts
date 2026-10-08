import mongoose from "mongoose"
import createError from "http-errors"
import { z } from "zod"
import { TController } from "src/typings/controllers"
import { IUserDocument } from "src/typings/users"
import CartModel from "../carts/model"
import { logEntry } from "../carts/managerControllers"
import { money } from "../../lib/money"
import { recordedOnCart } from "../carts/model"
import PaybackModel, { dinerNameOf, DONE_AS, DoneAs, forManagers, IPayback } from "./payback"

// A manager marking a pay-back done (S35). There are no staff roles yet: the
// shop's managers do it (isShopManager runs first).

// What the sheet showed and the manager confirmed: paid back, a dispute
// handled, or a payment a cart shows as paid checked.
export const paybackDoneSchema = z.object({ as: z.enum(DONE_AS) })

// What a pay-back is marked as now: a dispute first (what to do about it
// outranks a check), then a hand-over a cart shows as paid, else paid back.
const doneAsNow = async (payback: IPayback): Promise<DoneAs> => {
    if (payback.disputed) return "handled"
    if (payback.kind === "refundRefused" && await recordedOnCart(payback.paymentIntentId)) return "checked"
    return "paidBack"
}

const DONE_WORDS: Record<DoneAs, string> = {
    paidBack: "marked paid back to",
    handled: "marked handled (disputed) for",
    checked: "marked checked (shown as paid) for",
}

const answer = async (payback: IPayback) => ({ payback: (await forManagers([payback]))[0] })

// POST /shops/:shopId/paybacks/:paybackId/done { as }. One already done (by
// another manager, say) answers as it was marked, whatever was asked. One
// that changed since the sheet showed it (a cart now shows the payment as
// paid) is refused, so what's stored is what the manager confirmed. The
// pay-back is the record; the line on its cart is a convenience, written
// without touching the cart's `updatedAt` (it would bring an old closed cart
// back into the day its payments can be refunded from the sheet).
export const markPaybackDone: TController = async (req, res, next) => {
    try {
        const { shopId, paybackId } = req.params as { shopId: string; paybackId: string }
        const { as } = req.body as z.infer<typeof paybackDoneSchema>
        const user = req.user as IUserDocument
        if (!mongoose.isValidObjectId(paybackId)) return next(createError(404, "Pay-back Not Found!"))

        const payback = await PaybackModel.findOne({ _id: paybackId, shopId }).lean()
        if (!payback) return next(createError(404, "Pay-back Not Found!"))
        if (!payback.owed) return res.send(await answer(payback))
        const doneAs = await doneAsNow(payback)
        if (as !== doneAs) return next(createError(409, "This pay-back changed: here it is again"))

        const done = await PaybackModel.findOneAndUpdate(
            { _id: paybackId, shopId, owed: true },
            { $set: { doneAt: new Date(), doneByUserId: user._id, doneAs }, $unset: { owed: 1 } },
        ).lean()
        // Marked meanwhile by someone else: as they marked it. Or gone with
        // its shop, deleted meanwhile.
        if (!done) {
            const now = await PaybackModel.findById(paybackId).lean()
            return now ? res.send(await answer(now)) : next(createError(404, "Pay-back Not Found!"))
        }

        try {
            const name = await dinerNameOf(done.userId)
            const details = `${money(done.amount, done.currency)} ${DONE_WORDS[doneAs]} ${name} ` +
                `(${done.paymentIntentId ? `payment ${done.paymentIntentId}; ` : ""}pay-back ${done._id})`
            // Its cart gone (closed and deleted: normal for a hand-over): no line.
            await CartModel.updateOne(
                { _id: done.cartId },
                { $push: { managerLog: logEntry(user._id, "paybackDone", details) } },
                { timestamps: false }
            )
        } catch (error) {
            console.error("A pay-back was marked done, but its line on the cart couldn't be written", { paybackId, error })
        }
        res.send(await answer(done))
    } catch (error) {
        next(createError(500, error as Error))
    }
}

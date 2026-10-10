import { Document } from "mongoose"

// A unique index refused the write (the driver's code 11000, top-level or
// wrapped as the cause, depending on the call).
export const isDuplicateKey = (error: unknown) => {
    const err = error as { code?: number; cause?: { code?: number } }
    return err.code === 11000 || err.cause?.code === 11000
}

// A version-checked save() met a newer version of the document.
export const isVersionConflict = (error: unknown) => (error as { name?: string }).name === "VersionError"

// save(), false on a version conflict.
export const saveChecked = async (doc: Document) => {
    try {
        await doc.save()
        return true
    } catch (error) {
        if (isVersionConflict(error)) return false
        throw error
    }
}

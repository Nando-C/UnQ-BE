import { v2 as cloudinary } from "cloudinary"
import multer, { StorageEngine } from "multer"

// cloudinary v2 auto-configures from the CLOUDINARY_URL env var, exactly like v1.

// -------------------------------------------------------------------------

// A small multer StorageEngine that streams the uploaded file straight to
// Cloudinary. It replaces `multer-storage-cloudinary` (which pinned cloudinary
// v1). Controllers only ever read `req.file?.path`, and the previous library set
// `path` to the secure URL — so we do the same here to keep behavior identical.
const cloudinaryStorage = (folder: string): StorageEngine => ({
    _handleFile(req, file, cb) {
        const upload = cloudinary.uploader.upload_stream({ folder }, (err, result) => {
            if (err || !result) return cb(err ?? new Error("Cloudinary upload failed"))
            cb(null, {
                path: result.secure_url,
                filename: result.public_id,
                size: result.bytes,
            })
        })
        file.stream.pipe(upload)
    },
    _removeFile(req, file, cb) {
        cloudinary.uploader.destroy(file.filename).then(
            () => cb(null),
            (err) => cb(err),
        )
    },
})

// -------------------------------------------------------------------------

export const userAvatarParser = multer({ storage: cloudinaryStorage("UnQ-App/Users") })

export const shopCoverParser = multer({ storage: cloudinaryStorage("UnQ-App/Shops") })

export const menuItemImageParser = multer({ storage: cloudinaryStorage("UnQ-App/MenuItems") })

// -------------------------------------------------------------------------

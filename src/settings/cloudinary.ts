import { v2 as cloudinary } from "cloudinary"
import multer, { StorageEngine } from "multer"
import createError from "http-errors"
import { Request, RequestHandler } from "express"

// The SDK configures itself from CLOUDINARY_URL (checked in settings/env.ts).

// -------------------------------------------------------------------------

// A multer StorageEngine that streams the uploaded file straight to
// Cloudinary. Controllers read the image's URL from `req.file.path`;
// `filename` is the Cloudinary public id, which discardUpload deletes by.
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

// Every upload is one image of at most 5 MB, in a format browsers and
// Cloudinary both handle. SVG is left out: it can carry scripts. The type is
// what the browser reports, which is enough to stop mistakes; Cloudinary
// rejects a file that isn't really an image.
const MAX_IMAGE_MB = 5
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/heic", "image/heif"]

// multer for one image field, as route middleware. A file over the limit is cut
// off mid-stream; multer then deletes what reached Cloudinary through
// _removeFile. Multer's own errors carry no HTTP status, so they are given one
// here instead of surfacing as a 500, and a request with no file is refused
// before the handler could save "no image" over the current one.
const imageUpload = (folder: string, field: string): RequestHandler => {
    const parse = multer({
        storage: cloudinaryStorage(folder),
        limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024, files: 1 },
        fileFilter(req, file, cb) {
            if (IMAGE_TYPES.includes(file.mimetype)) return cb(null, true)
            cb(createError(400, "Only JPEG, PNG, WebP, GIF, AVIF or HEIC images can be uploaded"))
        },
    }).single(field)

    return (req, res, next) =>
        parse(req, res, (err?: unknown) => {
            if (err instanceof multer.MulterError) {
                return next(err.code === "LIMIT_FILE_SIZE"
                    ? createError(413, `The image is too large (max ${MAX_IMAGE_MB} MB)`)
                    : createError(400, err.message))
            }
            if (err) return next(err)
            if (!req.file) return next(createError(400, `No image was sent (field "${field}")`))
            next()
        })
}

export const userAvatarUpload = imageUpload("UnQ-App/Users", "avatar")

export const shopCoverUpload = imageUpload("UnQ-App/Shops", "cover")

export const menuItemImageUpload = imageUpload("UnQ-App/MenuItems", "image")

// -------------------------------------------------------------------------

// Deleting images. Neither ever fails the request: a leftover image costs a
// little storage, a failed save would cost the user their change.
const destroy = (publicId: string) =>
    cloudinary.uploader.destroy(publicId).catch((error: unknown) => {
        console.error(`Couldn't delete Cloudinary image ${publicId}`, error)
    })

// The image this request uploaded, when the handler then refuses or fails the
// request, so nothing is left in Cloudinary that no record points to.
export const discardUpload = (req: Request) => {
    if (req.file?.filename) void destroy(req.file.filename)
}

// An image a record no longer uses, once its replacement is saved. Only one
// this app uploaded is deleted, recognised by its folder in the URL
// (…/image/upload/v123/UnQ-App/…/id.jpg). Defaults, placeholders and Google
// avatars are left alone.
export const destroyReplacedImage = (url: string | undefined) => {
    const publicId = url?.match(/\/image\/upload\/(?:v\d+\/)?(UnQ-App\/[^?#]+?)(?:\.[a-z0-9]+)?$/i)?.[1]
    if (publicId) void destroy(publicId)
}

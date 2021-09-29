import {v2 as cloudinary } from "cloudinary"
import { CloudinaryStorage } from "multer-storage-cloudinary"
import multer from "multer"

const avatarStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
        return {
            folder: "UnQ-App/Users",
        }
    },
})

export const userAvatarParser = multer({ storage: avatarStorage})

const coverStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
        return {
            folder: "UnQ-App/Shops",
        }
    },
})

export const shopCoverParser = multer({ storage: coverStorage})
import { Document, Types } from "mongoose"

export interface IMenu {
    name: string
    image: string
    short_description: string
    description: string
    price: number
    available: boolean
    category: string
    // Set when the item is deleted: it leaves the menu but is kept, so the
    // carts that hold it still name it (see deleteItem).
    deletedFrom?: Types.ObjectId
}

export interface IMenuDocument extends Document, IMenu {}
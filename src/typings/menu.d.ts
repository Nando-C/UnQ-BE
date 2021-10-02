import { Document, Schema } from "mongoose"

export interface IMenu {
    name: string
    image: string
    short_description: string
    description: string
    price: number
    available: boolean
    category: string
}

export interface IMenuDocument extends Document, IMenu {}
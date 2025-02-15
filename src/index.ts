import mongoose from "mongoose"
import listEndpoints from "express-list-endpoints"
import app from "./server"

const PORT = process.env.PORT || 3001

console.table(listEndpoints(app))

mongoose.set('returnOriginal', false)
mongoose.set('strictQuery', true)

mongoose.connect(process.env.MONGO_CONNECTION!)
    .then(() => app.listen(PORT, () => {
        console.log("Connected to MongoDB 🌱 ")
        console.log(" ✅  Server is running on port: " + PORT)
    }))
    .catch((err) => {
        console.log(" 🚫 Database error: ", err);
        process.exit(1)
    })
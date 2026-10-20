import "dotenv/config";
import express from "express";
import cors from "cors";
import { v2 as cloudinary } from "cloudinary";

import imageRoutes from "./routes/images.js";
import galleryRoutes from "./routes/gallery.js";

const app = express();


// MIDDLEWARE
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json());


// CLOUDINARY CONFIG
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// CLOUDINARY CONFIG CHECK
console.log("\n=================================");
console.log("☁️ CLOUDINARY CONFIG");
console.log("=================================");

console.log(
  "Cloud name:",
  process.env.CLOUDINARY_CLOUD_NAME
);

console.log(
  "API key:",
  process.env.CLOUDINARY_API_KEY
    ? "Loaded ✅"
    : "Missing ❌"
);

console.log(
  "API secret:",
  process.env.CLOUDINARY_API_SECRET
    ? "Loaded ✅"
    : "Missing ❌"
);

// ROUTES
app.use(
  "/api/images",
  imageRoutes
);

app.use(
  "/api/gallery",
  galleryRoutes
);

// HOME
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Rotary Gallery Backend Running 🚀",
  });
});

// HEALTH
app.get("/health", (req, res) => {
  res.json({
    success: true,
    server: "running",
    cloudinary:
      process.env.CLOUDINARY_CLOUD_NAME
        ? "configured"
        : "not configured",
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// SERVER
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {

  console.log("\n=================================");
  console.log(
    `🚀 Server running: http://localhost:${PORT}`
  );
  console.log(
    `📸 Image API: http://localhost:${PORT}/api/images`
  );
  console.log("=================================\n");

});
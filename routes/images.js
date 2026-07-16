import express from "express";
import { v2 as cloudinary } from "cloudinary";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const folder = req.query.folder;

    if (!folder) {
      return res.status(400).json({
        message: "Folder name is required",
      });
    }

    const result = await cloudinary.search
      .expression(`folder="${folder}"`)
      .sort_by("public_id", "asc")
      .max_results(500)
      .execute();

    const images = result.resources.map((img) => ({
      id: img.asset_id,
      public_id: img.public_id,
      url: img.secure_url,
    }));

    res.json(images);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: error.message,
    });
  }
});

export default router;
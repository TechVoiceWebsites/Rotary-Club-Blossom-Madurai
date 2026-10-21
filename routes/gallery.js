import express from "express";
import multer from "multer";
import cloudinary from "../config/cloudinary.js";
import supabase from "../config/supabase.js";

const router = express.Router();

// Store uploaded files temporarily in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB per image
  },
});

// Test route
router.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "Gallery route working 🚀",
  });
});

// ======================================================
// GET ALL GALLERY IMAGES (Filters: category, year)
// ======================================================
router.get("/", async (req, res) => {
  try {
    const { category, year, event_name } = req.query;

    let query = supabase
      .from("gallery_images")
      .select("*")
      .order("event_date", { ascending: false });

    if (category) query = query.eq("category", category);
    if (year) query = query.eq("year", parseInt(year));
    if (event_name) query = query.ilike("event_name", `%${event_name}%`);

    const { data, error } = await query;

    if (error) throw error;

    return res.status(200).json({
      success: true,
      count: data.length,
      images: data,
    });
  } catch (error) {
    console.error("Fetch error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch gallery images",
      error: error.message,
    });
  }
});

// ======================================================
// MULTIPLE IMAGE UPLOAD (Parallel + Bulk DB Insert)
// ======================================================
router.post("/upload", upload.array("images", 50), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No images selected",
      });
    }

    const { category, year, event_date, event_name, folder } = req.body;

    if (!category || !year || !event_date || !event_name || !folder) {
      return res.status(400).json({
        success: false,
        message: "Category, year, date, event name, and folder are required",
      });
    }

    // Helper function: Cloudinary upload stream
    const uploadToCloudinary = (fileBuffer) => {
      return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: `events/${folder}`,
            resource_type: "image",
            transformation: [
              {
                quality: "auto",
                fetch_format: "auto",
              },
            ],
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(fileBuffer);
      });
    };

    // 1. Upload all images to Cloudinary concurrently
    const uploadResults = await Promise.all(
      req.files.map((file) => uploadToCloudinary(file.buffer))
    );

    // 2. Prepare payload for single bulk database insert
    const dbPayload = uploadResults.map((result, index) => ({
      category,
      year: Number(year),
      event_date,
      event_name,
      folder,
      cloudinary_public_id: result.public_id,
      image_url: result.secure_url,
      width: result.width,
      height: result.height,
      sort_order: index,
    }));

    // 3. Insert all records in one Supabase query
    const { data, error: dbError } = await supabase
      .from("gallery_images")
      .insert(dbPayload)
      .select();

    if (dbError) {
      console.error("Supabase insert error:", dbError);
      return res.status(500).json({
        success: false,
        message: "Images uploaded to Cloudinary, but database record failed",
        error: dbError.message,
      });
    }

    return res.status(201).json({
      success: true,
      message: `${data.length} image(s) uploaded successfully`,
      images: data,
    });
  } catch (error) {
    console.error("Gallery upload error:", error);
    return res.status(500).json({
      success: false,
      message: "Image upload failed",
      error: error.message,
    });
  }
});

// ======================================================
// DELETE GALLERY IMAGE (From Supabase & Cloudinary)
// ======================================================
router.delete("/delete", async (req, res) => {
  try {
    const { id, public_id } = req.body;

    if (!id && !public_id) {
      return res.status(400).json({
        success: false,
        message: "Image ID or public_id is required",
      });
    }

    // 1. Cloudinary-ல் இருந்து டெலீட் செய்ய
    if (public_id) {
      await cloudinary.uploader.destroy(public_id);
    }

    // 2. Supabase டேட்டாபேஸில் இருந்து டெலீட் செய்ய (இப்போது துல்லியமாக ஒப்பிட்டு நீக்கும்)
    let query = supabase.from("gallery_images").delete();
    if (id) {
      query = query.eq("id", id);
    } else {
      query = query.or(`cloudinary_public_id.eq.${public_id},image_url.ilike.%${public_id}%`);
    }

    const { error } = await query;

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: "Image deleted successfully from database and Cloudinary!",
    });
  } catch (error) {
    console.error("Delete error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete image",
      error: error.message,
    });
  }
});

export default router;
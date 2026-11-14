import express from "express";
import multer from "multer";
import cloudinary from "../config/cloudinary.js";
import supabase from "../config/supabase.js";

const router = express.Router();

// Store uploaded files temporarily in memory using multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB per image
  },
});

// Helper: Folder path-la irunthu Category, Year, Event Date, Event Name dynamic-a pirikka
function parseFolderMetadata(folder, overrides = {}) {
  const pathParts = folder.split("/").filter(Boolean);
  const category = overrides.category || (pathParts.length > 2 ? pathParts[2] : "Events");

  const yearMatch = folder.match(/(?:20\d{2})/);
  const year = overrides.year
    ? Number(overrides.year)
    : Number(yearMatch ? yearMatch[0] : new Date().getFullYear());

  const rawFolderName = pathParts[pathParts.length - 1] || "General Event";

  // Date parsing (e.g. "14-nov-2026" or "14-nov-2026_Event Name" or "02-04-oct-2026_RYLA")
  let event_date = overrides.event_date || null;
  if (!event_date) {
    let parsedDate = new Date().toISOString().split("T")[0];
    const dateMatch = rawFolderName.match(/(\d{1,2})(?:-\d{1,2})?[,\s-]+([a-zA-Z]{3})[,\s-]+(20\d{2})/);
    if (dateMatch) {
      const day = dateMatch[1].padStart(2, "0");
      const monthStr = dateMatch[2].toLowerCase();
      const yr = dateMatch[3];
      const months = {
        jan: "01", feb: "02", mar: "03", apr: "04",
        may: "05", jun: "06", jul: "07", aug: "08",
        sep: "09", oct: "10", nov: "11", dec: "12",
      };
      const month = months[monthStr] || "01";
      parsedDate = `${yr}-${month}-${day}`;
    }
    event_date = parsedDate;
  }

  // Event name parsing: "14-nov-2026_Diwali Celebration" -> "Diwali Celebration"
  let event_name = overrides.event_name || null;
  if (!event_name) {
    const splitByDelimiter = rawFolderName.match(/^\d{1,2}(?:-\d{1,2})?-[a-zA-Z]{3}-20\d{2}[_\-\s]+(.+)$/);
    if (splitByDelimiter && splitByDelimiter[1]) {
      event_name = splitByDelimiter[1].trim();
    } else {
      event_name = rawFolderName.replace(/[-_]/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    }
  }

  return { category, year, event_date, event_name };
}

// Test route
router.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "Gallery route working 🚀",
  });
});

// ======================================================
// GET ALL GALLERY IMAGES (Filters: category, year, folder)
// ======================================================
router.get("/", async (req, res) => {
  try {
    const { category, year, event_name, folder } = req.query;

    let query = supabase
      .from("gallery_images")
      .select("*")
      .order("event_date", { ascending: false });

    if (category) query = query.eq("category", category);
    if (year) query = query.eq("year", parseInt(year));
    if (event_name) query = query.ilike("event_name", `%${event_name}%`);
    if (folder) query = query.ilike("folder", `${folder}%`);

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
// MULTIPLE IMAGE UPLOAD (Parallel + Bulk DB Insert + 100% Dynamic)
// ======================================================
router.post("/upload", upload.any(), async (req, res) => {
  try {
    console.log("📥 Incoming Upload Request Files:", req.files ? req.files.length : 0);
    console.log("📥 Incoming Body Data:", req.body);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No images selected or files missing in request",
      });
    }

    const { folder } = req.body;

    if (!folder) {
      return res.status(400).json({
        success: false,
        message: "Folder path is required",
      });
    }

    // --- FULLY DYNAMIC PARSING FROM FOLDER IF MISSING ---
    const { category, year, event_date, event_name } = parseFolderMetadata(folder, req.body);

    // Helper function: Cloudinary upload stream
    const uploadToCloudinary = (fileBuffer) => {
      return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: folder, // Direct folder path
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
      console.error("❌ Supabase insert error:", dbError);
      return res.status(500).json({
        success: false,
        message: "Images uploaded to Cloudinary, but database record failed",
        error: dbError.message,
      });
    }

    return res.status(201).json({
      success: true,
      message: `${data.length} image(s) uploaded successfully to Cloudinary & Database!`,
      images: data,
    });
  } catch (error) {
    console.error("❌ Gallery upload error:", error);
    return res.status(500).json({
      success: false,
      message: "Image upload failed",
      error: error.message,
    });
  }
});

// ======================================================
// SYNC CLOUDINARY FOLDER TO SUPABASE (No Duplicates + Subfolder Support)
// ======================================================
router.post("/sync", async (req, res) => {
  try {
    const { folder } = req.body;

    if (!folder) {
      return res.status(400).json({
        success: false,
        message: "Folder path is required",
      });
    }

    // 1. Cloudinary-la irunthu antha folder + subfolders-oda ella images-aiyum edukka
    const cloudinaryRes = await cloudinary.search
      .expression(`(folder:"${folder}/*" OR folder:"${folder}") AND resource_type:image`)
      .sort_by("public_id", "asc")
      .max_results(500)
      .execute();

    const resources = cloudinaryRes.resources || [];
    if (resources.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No images found in Cloudinary for this folder",
      });
    }

    // 2. Supabase-la already irukura public_id-galai check panna (Duplicate thavirkka)
    const { data: existingRows, error: fetchError } = await supabase
      .from("gallery_images")
      .select("cloudinary_public_id")
      .ilike("folder", `${folder}%`);

    if (fetchError) throw fetchError;

    const existingIds = new Set(
      (existingRows || []).map((row) => row.cloudinary_public_id)
    );

    // Puthu images-a mattum filter panna
    const newResources = resources.filter(
      (item) => !existingIds.has(item.public_id)
    );

    if (newResources.length === 0) {
      return res.status(200).json({
        success: true,
        message: "All Cloudinary images are already synced with Supabase!",
        syncedCount: 0,
      });
    }

    // 3. Dynamic parsing & Supabase-la insert panna payload ready panna
    const dbPayload = newResources.map((item, index) => {
      const itemFolder =
        item.asset_folder || item.folder || item.public_id.split("/").slice(0, -1).join("/") || folder;
      const meta = parseFolderMetadata(itemFolder, req.body);

      return {
        category: meta.category,
        year: meta.year,
        event_date: meta.event_date,
        event_name: meta.event_name,
        folder: itemFolder,
        cloudinary_public_id: item.public_id,
        image_url: item.secure_url,
        width: item.width,
        height: item.height,
        sort_order: existingIds.size + index,
      };
    });

    const { data: insertedData, error: insertError } = await supabase
      .from("gallery_images")
      .insert(dbPayload)
      .select();

    if (insertError) throw insertError;

    return res.status(201).json({
      success: true,
      message: `${insertedData.length} new image(s) synced to Supabase!`,
      syncedCount: insertedData.length,
      images: insertedData,
    });
  } catch (error) {
    console.error("❌ Cloudinary Sync Error:", error);
    return res.status(500).json({
      success: false,
      message: "Sync failed",
      error: error.message,
    });
  }
});

// ======================================================
// CLOUDINARY WEBHOOK (100% Auto-Sync on Direct Dashboard Upload / Delete)
// ======================================================
router.post("/webhook", async (req, res) => {
  try {
    const payload = req.body;
    console.log("🔔 Cloudinary Webhook Received:", payload?.notification_type);

    // 1. Photo Upload aanaal (notification_type === 'upload')
    if (payload?.notification_type === "upload" && payload?.public_id) {
      const publicId = payload.public_id;
      const folder = payload.asset_folder || payload.folder || publicId.split("/").slice(0, -1).join("/");

      if (!folder.startsWith("Rotary")) {
        return res.status(200).json({ success: true, ignored: true });
      }

      const { data: existing } = await supabase
        .from("gallery_images")
        .select("id")
        .eq("cloudinary_public_id", publicId)
        .maybeSingle();

      if (existing) {
        return res.status(200).json({ success: true, message: "Already exists in DB" });
      }

      const { category, year, event_date, event_name } = parseFolderMetadata(folder);

      const { error: insertError } = await supabase.from("gallery_images").insert([
        {
          category,
          year,
          event_date,
          event_name,
          folder,
          cloudinary_public_id: publicId,
          image_url: payload.secure_url,
          width: payload.width,
          height: payload.height,
        },
      ]);

      if (insertError) throw insertError;
      console.log(`✅ Auto-synced from Cloudinary Webhook: ${publicId}`);
    }

    // 2. Cloudinary Dashboard-la Delete pannaal Supabase-layum delete aagum
    if (payload?.notification_type === "delete" && Array.isArray(payload?.resources)) {
      const publicIds = payload.resources.map((r) => r.public_id).filter(Boolean);
      if (publicIds.length > 0) {
        await supabase
          .from("gallery_images")
          .delete()
          .in("cloudinary_public_id", publicIds);
        console.log(`🗑️ Auto-deleted from Supabase via Webhook:`, publicIds);
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("❌ Webhook Error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ======================================================
// DELETE GALLERY IMAGE (From Supabase & Cloudinary)
// ======================================================
router.delete("/delete", async (req, res) => {
  try {
    const { id, public_id } = req.body;

    console.log("🗑️ Delete Request Received for ID/Public_ID:", id || public_id);

    if (!id && !public_id) {
      return res.status(400).json({
        success: false,
        message: "Image ID or public_id is required",
      });
    }

    // 1. Supabase டேட்டாபேஸில் இருந்து பாதுகாப்பாக டெலீட் செய்ய (Service Role Key மூலம் Row நீக்கப்படும்)
    let query = supabase.from("gallery_images").delete();
    if (id) {
      query = query.eq("id", id);
    } else {
      query = query.eq("cloudinary_public_id", public_id);
    }

    const { data: deletedData, error: dbError } = await query.select();

    if (dbError) {
      console.error("❌ Supabase delete error:", dbError);
      throw dbError;
    }

    console.log("✅ Supabase deleted rows:", deletedData);

    // 2. Cloudinary-ல் இருந்து டெலீட் செய்ய
    if (public_id) {
      const cloudinaryResult = await cloudinary.uploader.destroy(public_id);
      console.log("☁️ Cloudinary destroy result:", cloudinaryResult);
    }

    return res.status(200).json({
      success: true,
      message: "Image deleted successfully from database and Cloudinary!",
    });
  } catch (error) {
    console.error("❌ Delete error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete image",
      error: error.message,
    });
  }
});

export default router;
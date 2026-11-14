import express from "express";
import fs from "fs/promises";
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import supabase from "../config/supabase.js"; // Supabase client import

const router = express.Router();

// Temporary storage for uploaded files (deleted after Cloudinary upload)
const upload = multer({ dest: "uploads/" });

// Root folder in Cloudinary that the admin can upload into
const ROOT_FOLDER = "Rotary";

// ======================================================
// FOLDER FETCHING (dynamic + recursive + paginated)
// ======================================================

async function fetchDirectSubFolders(parentPath) {
  let folders = [];
  let nextCursor;

  do {
    const result = await cloudinary.api.sub_folders(parentPath, {
      max_results: 500,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    });

    folders = folders.concat(result.folders || []);
    nextCursor = result.next_cursor;
  } while (nextCursor);

  return folders;
}

// Walks the whole tree under parentPath. Sibling branches load in parallel.
async function getAllSubFolders(parentPath) {
  const direct = await fetchDirectSubFolders(parentPath);

  const nested = await Promise.all(
    direct.map((folder) => getAllSubFolders(folder.path))
  );

  return direct.concat(...nested);
}

// ======================================================
// GET /api/images/folders (NO CACHE - 100% Realtime)
// ======================================================
router.get("/folders", async (req, res) => {
  try {
    const subFolders = await getAllSubFolders(ROOT_FOLDER);
    const folders = subFolders.map((f) => ({ name: f.name, path: f.path }));

    return res.status(200).json({
      success: true,
      cached: false,
      count: folders.length,
      folders,
    });
  } catch (err) {
    console.error("❌ FOLDER FETCH ERROR:", err);
    return res.status(500).json({
      success: false,
      message: err?.error?.message || err.message || "Failed to fetch folders",
    });
  }
});

// ======================================================
// GET /api/images/grouped?baseFolder=... (100% Dynamic Event Groups)
// ======================================================
router.get("/grouped", async (req, res) => {
  try {
    const baseFolder = req.query.baseFolder;
    if (!baseFolder) {
      return res.status(400).json({
        success: false,
        message: "baseFolder is required",
      });
    }

    const decodedBase = decodeURIComponent(baseFolder);

    const { data, error } = await supabase
      .from("gallery_images")
      .select("*")
      .ilike("folder", `${decodedBase}%`)
      .order("event_date", { ascending: false })
      .order("created_at", { ascending: true });

    if (error) throw error;

    const groupsMap = new Map();

    for (const row of data || []) {
      const folderPath = row.folder || decodedBase;
      if (!groupsMap.has(folderPath)) {
        const subName = folderPath.split("/").pop() || "";
        // Format date nicely (e.g. "2026-11-14" -> "14 Nov 2026")
        let formattedDate = subName;
        if (row.event_date) {
          const d = new Date(row.event_date + "T00:00:00");
          if (!isNaN(d.getTime())) {
            formattedDate = d.toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            });
          }
        }

        groupsMap.set(folderPath, {
          folder: subName,
          fullFolder: folderPath,
          rawEventDate: row.event_date || "1970-01-01",
          date: formattedDate,
          eventName: row.event_name || subName,
          images: [],
        });
      }

      groupsMap.get(folderPath).images.push({
        id: row.id,
        public_id: row.cloudinary_public_id,
        url: row.image_url,
        width: row.width,
        height: row.height,
        created_at: row.created_at,
      });
    }

    // Latest event_date mela varura maari sort
    const groups = Array.from(groupsMap.values()).sort((a, b) =>
      b.rawEventDate.localeCompare(a.rawEventDate)
    );

    return res.json({
      success: true,
      groups,
    });
  } catch (error) {
    console.error("❌ GROUPED FETCH ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ======================================================
// GET /api/images?folder=... (INSTANT FETCH FROM SUPABASE DATABASE)
// ======================================================
router.get("/", async (req, res) => {
  try {
    const folder = req.query.folder;

    if (!folder) {
      return res.status(400).json({
        success: false,
        message: "Folder name is required",
      });
    }

    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    // Decoding folder name incase it has URL encoding like %2F
    const decodedFolder = decodeURIComponent(folder);

    // 🚀 Cloudinary search-ku bathila direct-ah Supabase database-il irunthu edukkrom (No Delay!)
    const { data, error, count } = await supabase
      .from("gallery_images")
      .select("*", { count: "exact" })
      .ilike("folder", `%${decodedFolder}%`)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw error;
    }

    const images = (data || []).map((img) => ({
      id: img.id,
      public_id: img.cloudinary_public_id,
      url: img.image_url,
      width: img.width,
      height: img.height,
      created_at: img.created_at,
    }));

    const total = count || images.length;

    return res.json({
      success: true,
      images,
      total,
      page,
      limit,
      hasMore: offset + images.length < total,
    });
  } catch (error) {
    console.error("❌ SUPABASE FETCH ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ======================================================
// POST /api/images/upload (Cloudinary Upload + Supabase Instant Insert)
// ======================================================
router.post("/upload", upload.any(), async (req, res) => {
  const files = req.files || [];

  try {
    const folder = req.body.folder;

    if (!folder) {
      return res.status(400).json({
        success: false,
        message: "Folder name is required for upload",
      });
    }

    if (files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No files uploaded",
      });
    }

    // Folder name-la irunthu date & event_name dynamic-a parse panna (e.g. "14-nov-2026_Diwali Celebration")
    const rawFolderName = folder.split("/").pop() || "";
    let parsedDate = req.body.event_date || new Date().toISOString().split("T")[0];
    const dateMatch = rawFolderName.match(/(\d{1,2})(?:-\d{1,2})?[,\s-]+([a-zA-Z]{3})[,\s-]+(20\d{2})/);
    if (!req.body.event_date && dateMatch) {
      const months = {
        jan: "01", feb: "02", mar: "03", apr: "04",
        may: "05", jun: "06", jul: "07", aug: "08",
        sep: "09", oct: "10", nov: "11", dec: "12",
      };
      parsedDate = `${dateMatch[3]}-${months[dateMatch[2].toLowerCase()] || "01"}-${dateMatch[1].padStart(2, "0")}`;
    }

    const splitName = rawFolderName.match(/^\d{1,2}(?:-\d{1,2})?-[a-zA-Z]{3}-20\d{2}[_\-\s]+(.+)$/);
    const parsedEventName =
      req.body.event_name ||
      (splitName?.[1] ? splitName[1].trim() : rawFolderName.replace(/[-_]/g, " "));

    const results = await Promise.allSettled(
      files.map((file) =>
        cloudinary.uploader.upload(file.path, {
          folder,
          resource_type: "image",
        })
      )
    );

    const uploadedImages = [];
    let failedCount = 0;

    for (const r of results) {
      if (r.status === "fulfilled") {
        const cloudResult = r.value;
        const imageData = {
          folder: folder,
          category: folder.split('/')[2] || 'Events',
          year: Number(folder.match(/(?:20\d{2})/)?.[0]) || new Date().getFullYear(),
          event_name: parsedEventName,
          event_date: parsedDate,
          cloudinary_public_id: cloudResult.public_id,
          image_url: cloudResult.secure_url,
          width: cloudResult.width,
          height: cloudResult.height,
        };

        // Supabase-la odaney insert panrom
        const { data: dbData, error: dbError } = await supabase
          .from("gallery_images")
          .insert([imageData])
          .select();

        if (dbError) {
          console.error("❌ Supabase insert error during upload:", dbError);
        } else if (dbData && dbData.length > 0) {
          uploadedImages.push({
            id: dbData[0].id,
            public_id: cloudResult.public_id,
            url: cloudResult.secure_url,
          });
        }
      } else {
        failedCount++;
        console.error("❌ One file failed:", r.reason?.message || r.reason);
      }
    }

    if (uploadedImages.length === 0) {
      return res.status(500).json({
        success: false,
        message: "All uploads failed. Check backend console.",
      });
    }

    return res.json({
      success: true,
      message:
        failedCount > 0
          ? `${uploadedImages.length} photos uploaded, ${failedCount} failed.`
          : `${uploadedImages.length} photos uploaded successfully to Database & Cloudinary!`,
      images: uploadedImages,
    });
  } catch (error) {
    console.error("❌ UPLOAD ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  } finally {
    await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
  }
});

// ======================================================
// DELETE /api/images/delete (Delete image from Cloudinary & Supabase Database)
// ======================================================
router.delete('/delete', async (req, res) => {
  try {
    const { id, public_id } = req.body;

    if (!id && !public_id) {
      return res.status(400).json({
        success: false,
        message: 'Image ID or public_id is required to delete an image',
      });
    }

    // 1. Supabase Database-ல் இருந்து நீக்க
    let query = supabase.from("gallery_images").delete();
    if (id) {
      query = query.eq("id", id);
    } else {
      query = query.eq("cloudinary_public_id", public_id);
    }

    const { error: dbError } = await query;

    if (dbError) {
      console.error("❌ Supabase delete error:", dbError);
    }

    // 2. Cloudinary-ல் இருந்து நீக்க
    if (public_id) {
      const result = await cloudinary.uploader.destroy(public_id);
      console.log("☁️ Cloudinary destroy result:", result);
    }

    return res.json({
      success: true,
      message: "Image deleted successfully from Cloudinary and Database!",
    });
  } catch (error) {
    console.error("❌ DELETE ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

export default router;
import express from "express";
import fs from "fs/promises";
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";

const router = express.Router();

// Temporary storage for uploaded files (deleted after Cloudinary upload)
const upload = multer({ dest: "uploads/" });

// Root folder in Cloudinary that the admin can upload into
const ROOT_FOLDER = "Rotary";

// ======================================================
// FOLDER FETCHING (dynamic + recursive + paginated)
// ======================================================

// Cloudinary returns only 10 folders per call by default.
// max_results: 500 + next_cursor loop makes sure EVERY folder comes back.
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

// Cache so we don't hit the Cloudinary Admin API (rate limited) on every page load
const FOLDER_CACHE_TIME = 10 * 60 * 1000; // 10 minutes
let folderCache = { folders: null, time: 0 };

// ======================================================
// GET /api/images/folders
// Add ?refresh=true to bypass the cache
// ======================================================
router.get("/folders", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    const cacheValid =
      folderCache.folders && Date.now() - folderCache.time < FOLDER_CACHE_TIME;

    if (!forceRefresh && cacheValid) {
      return res.status(200).json({
        success: true,
        cached: true,
        count: folderCache.folders.length,
        folders: folderCache.folders,
      });
    }

    const subFolders = await getAllSubFolders(ROOT_FOLDER);

    // Only send what the frontend needs: { name, path }
    const folders = subFolders.map((f) => ({ name: f.name, path: f.path }));

    folderCache = { folders, time: Date.now() };

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
// GET /api/images?folder=...  (list images of a folder)
// ======================================================
const cache = new Map();
const CACHE_TIME = 60 * 60 * 1000; // 1 hour

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

    const cached = cache.get(folder);
    let resources = [];

    if (cached && Date.now() - cached.time < CACHE_TIME) {
      resources = cached.resources;
    } else {
      const result = await cloudinary.search
        .expression(`asset_folder="${folder}"`)
        .sort_by("created_at", "desc")
        .max_results(500)
        .execute();

      resources = result.resources || [];
      cache.set(folder, { resources, time: Date.now() });
    }

    const start = (page - 1) * limit;
    const end = start + limit;
    const selectedImages = resources.slice(start, end);

    const images = selectedImages.map((img) => ({
      id: img.asset_id || img.public_id,
      public_id: img.public_id,
      url: img.secure_url,
      width: img.width,
      height: img.height,
    }));

    return res.json({
      success: true,
      images,
      total: resources.length,
      page,
      limit,
      hasMore: end < resources.length,
    });
  } catch (error) {
    console.error("❌ CLOUDINARY ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ======================================================
// POST /api/images/upload   (field name: 'photos')
// ======================================================
router.post("/upload", upload.array("photos", 50), async (req, res) => {
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

    // allSettled -> one bad photo won't cancel the others
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

    results.forEach((r) => {
      if (r.status === "fulfilled") {
        uploadedImages.push({
          public_id: r.value.public_id,
          url: r.value.secure_url,
        });
      } else {
        failedCount++;
        console.error("❌ One file failed:", r.reason?.message || r.reason);
      }
    });

    // Clear image cache so new photos show up immediately
    cache.clear();

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
          : `${uploadedImages.length} photos uploaded successfully to Cloudinary!`,
      images: uploadedImages,
    });
  } catch (error) {
    console.error("❌ UPLOAD ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  } finally {
    // Always delete temp files so the uploads/ folder doesn't fill up
    await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
  }
});

export default router;
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

        // Helper: Folder path-la irunthu Category, Year, Event Date, Event Name dynamic-a pirikka
        function parseFolderMetadata(folder, overrides = {}) {
          const pathParts = folder.split("/").filter(Boolean);
          const category = overrides.category || (pathParts.length > 2 ? pathParts[2] : "Events");

          const yearMatch = folder.match(/(?:20\d{2})/);
          const year = overrides.year
            ? Number(overrides.year)
            : Number(yearMatch ? yearMatch[0] : new Date().getFullYear());

          const rawFolderName = pathParts[pathParts.length - 1] || "General Event";

          // Date parsing (e.g. "14-nov-2026" or "14-nov-2026_Event Name")
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

          // Event name parsing: "28-oct-2026_Clothes Donation Drive" -> "Clothes Donation Drive"
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

            const decodedFolder = decodeURIComponent(folder);

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

            const meta = parseFolderMetadata(folder, req.body);

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
                  category: meta.category,
                  year: meta.year,
                  event_name: meta.event_name,
                  event_date: meta.event_date,
                  cloudinary_public_id: cloudResult.public_id,
                  image_url: cloudResult.secure_url,
                  width: cloudResult.width,
                  height: cloudResult.height,
                };

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
        // SYNC FOLDER ROUTE (Auto-updates renamed Event Names in Supabase!)
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

            // 🚀 AUTO-UPDATE RENAMED FOLDERS/EVENT NAMES IN SUPABASE
            for (const item of resources) {
              const itemFolder = item.asset_folder || item.folder || item.public_id.split("/").slice(0, -1).join("/") || folder;
              const meta = parseFolderMetadata(itemFolder, req.body);

              await supabase
                .from("gallery_images")
                .update({
                  event_name: meta.event_name,
                  event_date: meta.event_date,
                  category: meta.category,
                  year: meta.year,
                })
                .eq("cloudinary_public_id", item.public_id);
            }

            const { data: existingRows, error: fetchError } = await supabase
              .from("gallery_images")
              .select("cloudinary_public_id")
              .ilike("folder", `${folder}%`);

            if (fetchError) throw fetchError;

            const existingIds = new Set(
              (existingRows || []).map((row) => row.cloudinary_public_id)
            );

            const newResources = resources.filter(
              (item) => !existingIds.has(item.public_id)
            );

            if (newResources.length === 0) {
              return res.status(200).json({
                success: true,
                message: "Folder synced! All event names & images are up to date.",
                syncedCount: 0,
              });
            }

            const dbPayload = newResources.map((item, index) => {
              const itemFolder =
                item.asset_folder || item.folder || item.public_id.split("/").slice(0, -1).join("/") || folder;
              const meta = parseFolderMetadata(itemFolder, req.body);

              return {
                folder: itemFolder,
                category: meta.category,
                year: meta.year,
                event_name: meta.event_name,
                event_date: meta.event_date,
                cloudinary_public_id: item.public_id,
                image_url: item.secure_url,
                width: item.width,
                height: item.height,
              };
            });

            const { data: insertedData, error: insertError } = await supabase
              .from("gallery_images")
              .insert(dbPayload)
              .select();

            if (insertError) throw insertError;

            return res.status(201).json({
              success: true,
              message: `${insertedData.length} new image(s) and metadata synced successfully!`,
              syncedCount: insertedData.length,
            });
          } catch (error) {
            console.error("❌ SYNC ERROR:", error);
            return res.status(500).json({
              success: false,
              message: error.message,
            });
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
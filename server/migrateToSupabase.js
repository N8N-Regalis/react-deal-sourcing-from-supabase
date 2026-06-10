import { google } from "googleapis";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "..", ".env") });

// Initialize Google Sheets API
const keyEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
let auth;

if (keyEnv && !keyEnv.startsWith("./") && !keyEnv.startsWith("/")) {
  const credentials = typeof keyEnv === "string" ? JSON.parse(keyEnv) : keyEnv;
  auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
} else {
  const keyFile =
    keyEnv && (keyEnv.startsWith("./") || keyEnv.startsWith("/"))
      ? keyEnv
      : join(__dirname, "react-deal-sourcer-45126b11537a.json");
  console.log("Using key file:", keyFile);
  auth = new google.auth.GoogleAuth({
    keyFile: keyFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

const sheets = google.sheets({ version: "v4", auth });

// Initialize Supabase client
function getSupabaseClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// Spreadsheet IDs
const SUBMISSIONS_SHEET_ID = "1vRdVw3NywawevVlWVc9Rlu0m9PGcVb--6tVjkDLH4bg";
const ARCHIVE_SHEET_ID = "1id2PtF2f4t5IIp8-87V2s5wgutuCC5QWGtYijIn28Js";

// Function to fetch all data from Google Sheets
async function fetchAllSubmissions(spreadsheetId, sheetName) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: `${sheetName}!A:P`,
    });
    const rows = response.data.values || [];
    return rows.slice(1); // Skip header row
  } catch (error) {
    console.error(`Error fetching from ${sheetName}:`, error);
    return [];
  }
}

// Function to convert Google Sheets row to Supabase format
function convertRowToSupabase(row, tableName) {
  return {
    id: row[0] || generateId(tableName),
    timestamp: row[1] || new Date().toISOString(),
    user_email: row[2] || "",
    partner_name: row[3] || "",
    listing_name: row[4] || "",
    listing_link: row[5] || "",
    brokerage: row[6] || "N/A",
    broker_name: row[7] || "N/A",
    broker_email: row[8] || "",
    source_type: row[9] || "",
    notes: row[10] || "",
    cim_received: row[11] === "TRUE" || row[11] === true,
    status: row[12] || "",
    due_date: row[13] || null,
    modified_date: row[14] || null,
    sourcer_email: row[15] || "",
  };
}

function generateId(tableName) {
  const prefix = tableName === "submissions" ? "SUB" : "ARC";
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `${prefix}-${timestamp}-${random}`;
}

async function migrateData() {
  const supabase = getSupabaseClient();
  console.log("Starting migration from Google Sheets to Supabase...");
  
  // Migrate submissions
  console.log("\n=== Migrating Submissions ===");
  const submissionsData = await fetchAllSubmissions(SUBMISSIONS_SHEET_ID, "Submissions");
  console.log(`Found ${submissionsData.length} rows in Submissions sheet`);
  
  if (submissionsData.length > 0) {
    const convertedSubmissions = submissionsData.map(row => convertRowToSupabase(row, "submissions"));
    const batchSize = 100;
    for (let i = 0; i < convertedSubmissions.length; i += batchSize) {
      const batch = convertedSubmissions.slice(i, i + batchSize);
      const { error } = await supabase.from("submissions").insert(batch);
      if (error) {
        console.error(`Error inserting batch ${i + 1}-${Math.min(i + batchSize, convertedSubmissions.length)}:`, error);
      } else {
        console.log(`Inserted batch ${i + 1}-${Math.min(i + batchSize, convertedSubmissions.length)} of ${convertedSubmissions.length}`);
      }
    }
  }
  
  // Migrate archive
  console.log("\n=== Migrating Archive ===");
  const archiveData = await fetchAllSubmissions(ARCHIVE_SHEET_ID, "Archive");
  console.log(`Found ${archiveData.length} rows in Archive sheet`);
  
  if (archiveData.length > 0) {
    const convertedArchive = archiveData.map(row => convertRowToSupabase(row, "archive"));
    const batchSize = 100;
    for (let i = 0; i < convertedArchive.length; i += batchSize) {
      const batch = convertedArchive.slice(i, i + batchSize);
      const { error } = await supabase.from("archive").insert(batch);
      if (error) {
        console.error(`Error inserting batch ${i + 1}-${Math.min(i + batchSize, convertedArchive.length)}:`, error);
      } else {
        console.log(`Inserted batch ${i + 1}-${Math.min(i + batchSize, convertedArchive.length)} of ${convertedArchive.length}`);
      }
    }
  }
  
  console.log("\n=== Migration Complete ===");
  
  // Verify migration
  const { count: submissionsCount } = await supabase.from("submissions").select("*", { count: "exact", head: true });
  const { count: archiveCount } = await supabase.from("archive").select("*", { count: "exact", head: true });
  
  console.log(`Total submissions in Supabase: ${submissionsCount}`);
  console.log(`Total archive items in Supabase: ${archiveCount}`);
}

migrateData().catch(console.error);
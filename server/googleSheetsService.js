import { google } from "googleapis";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "..", ".env") });
dotenv.config({ path: join(__dirname, ".env") });

// In-memory cache with TTL (5 minutes for filter options, 30 seconds for submissions)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds
const SUBMISSIONS_CACHE_TTL = 30 * 1000; // 30 seconds in milliseconds

function getCache(key) {
  const cached = cache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiry) {
    cache.delete(key);
    return null;
  }
  return cached.data;
}

function setCache(key, data, customTTL = null) {
  cache.set(key, {
    data,
    expiry: Date.now() + (customTTL || CACHE_TTL)
  });
}

function clearCache() {
  cache.clear();
}

// Spreadsheet IDs
const PARTNERS_SHEET_ID = "1j0nSI9PPX1lhgwEQzmATtD8AtsXny11JysV77tVXMhE";
const SUBMISSIONS_SHEET_ID = "1vRdVw3NywawevVlWVc9Rlu0m9PGcVb--6tVjkDLH4bg";
const ARCHIVE_SHEET_ID = "1id2PtF2f4t5IIp8-87V2s5wgutuCC5QWGtYijIn28Js";

/**
 * Normalize URL for duplicate detection
 * - Converts hostname to lowercase
 * - Removes www. prefix
 * - Removes trailing slash
 * - Preserves important query parameters (listingId, id, listing, etc.)
 * - Removes tracking parameters (utm_*, fbclid, etc.)
 * - Normalizes protocol (HTTP/HTTPS treated the same)
 * @param {string} url - The URL to normalize
 * @returns {string} Normalized URL
 * @throws {Error} If URL is invalid
 */
export function normalizeUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid URL: URL must be a non-empty string');
  }

  try {
    // Parse URL
    const parsed = new URL(url);
    
    // Convert hostname to lowercase
    parsed.hostname = parsed.hostname.toLowerCase();
    
    // Remove www. prefix
    if (parsed.hostname.startsWith('www.')) {
      parsed.hostname = parsed.hostname.slice(4);
    }
    
    // Remove trailing slash from pathname
    parsed.pathname = parsed.pathname.replace(/\/$/, '');
    
    // Remove hash
    parsed.hash = '';
    
    // Preserve important query parameters, remove tracking parameters
    const importantParams = ['listingId', 'id', 'listing', 'propertyId', 'mls', 'mlsid'];
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
    
    const params = new URLSearchParams(parsed.search);
    const filteredParams = new URLSearchParams();
    
    for (const [key, value] of params.entries()) {
      const lowerKey = key.toLowerCase();
      // Keep if it's an important parameter or not a tracking parameter
      if (importantParams.includes(lowerKey) || !trackingParams.some(tp => lowerKey.startsWith(tp))) {
        filteredParams.append(key, value);
      }
    }
    
    // Update search with filtered parameters
    parsed.search = filteredParams.toString();
    
    // Reconstruct URL (protocol is normalized by URL constructor)
    return parsed.toString();
  } catch (error) {
    throw new Error(`Invalid URL: ${url}`);
  }
}

// Initialize Google Sheets API
let auth;
const keyEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

if (keyEnv && !keyEnv.startsWith("./") && !keyEnv.startsWith("/")) {
  // Parse JSON from environment variable (for production/Render)
  const credentials = typeof keyEnv === "string" ? JSON.parse(keyEnv) : keyEnv;
  auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
} else {
  // Use file (for local development)
  const rawKeyFile =
    keyEnv && (keyEnv.startsWith("./") || keyEnv.startsWith("/"))
      ? keyEnv
      : "./react-deal-sourcer-45126b11537a.json";
  // Resolve relative to the project root (one level up from server/)
  const keyFile = rawKeyFile.startsWith("/")
    ? rawKeyFile
    : join(__dirname, "..", rawKeyFile.replace(/^\.?\//, ""));
  auth = new google.auth.GoogleAuth({
    keyFile: keyFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

const sheets = google.sheets({ version: "v4", auth });

// Get Partners from Active Overview sheet
export async function getPartners() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: PARTNERS_SHEET_ID,
      range: "Active Overview!A3:A",
    });

    const values = response.data.values || [];
    return values.flat().filter(Boolean).map(String);
  } catch (error) {
    console.error("Error fetching partners:", error);
    throw error;
  }
}

// Get User Email (placeholder - in real app, this comes from auth)
export async function getUserEmail() {
  return process.env.USER_EMAIL || "";
}

// Helper function to check for duplicates in a specific sheet
async function checkDuplicateInSheet(sheetId, sheetName, partnerName, listingLink) {
  try {
    // Normalize the listing link for comparison
    const normalizedListingLink = normalizeUrl(listingLink);
    
    // Clean partner name by removing special characters
    const cleanedPartnerName = partnerName.replace(/[❗⭐]/g, '').trim();

    console.log(`Checking for duplicate in ${sheetName} sheet:`);
    console.log("Partner Name (cleaned):", cleanedPartnerName);
    console.log("Listing Link (normalized):", normalizedListingLink);

    // Fetch only columns D (Partner Name) and F (Listing Link) to reduce data transfer
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!D:F`,
    });

    const rows = response.data.values || [];

    // Skip header row
    const dataRows = rows.slice(1);

    console.log(`Total rows in ${sheetName} sheet:`, dataRows.length);

    // Early exit if no data
    if (dataRows.length === 0) {
      return false;
    }

    // Filter rows by partner name first (much faster than URL normalization)
    const partnerMatches = dataRows.filter((row) => {
      const existingPartner = String(row[0] || "").replace(/[❗⭐]/g, '').trim();
      return existingPartner === cleanedPartnerName;
    });

    console.log(`Partner matches found in ${sheetName}:`, partnerMatches.length);

    // If no partner matches, no need to check URLs
    if (partnerMatches.length === 0) {
      return false;
    }

    // Now check URL matches only for partner matches (much smaller dataset)
    const exists = partnerMatches.some((row) => {
      const existingLink = String(row[2] || "").trim();
      
      // Normalize existing link for comparison
      let normalizedExistingLink;
      try {
        normalizedExistingLink = normalizeUrl(existingLink);
      } catch (error) {
        // If existing link is invalid, skip this row
        return false;
      }
      
      const linkMatch = normalizedExistingLink === normalizedListingLink;
      return linkMatch;
    });

    console.log(`Duplicate found in ${sheetName}:`, exists);
    return exists;
  } catch (error) {
    console.error(`Error checking duplicate in ${sheetName}:`, error);
    // If sheet doesn't exist yet, return false
    return false;
  }
}

// Check if partner and listing link combination already exists in Submissions sheet or Archive sheet
export async function checkDuplicateSubmission(partnerName, listingLink) {
  console.log("Starting duplicate check...");

  // First check Submissions sheet
  const duplicateInSubmissions = await checkDuplicateInSheet(
    SUBMISSIONS_SHEET_ID,
    "Submissions",
    partnerName,
    listingLink
  );

  // If duplicate found in Submissions, throw error immediately (no need to check Archive)
  if (duplicateInSubmissions) {
    console.log("Duplicate found in Submissions sheet - skipping Archive check");
    throw new Error('Listing Link already exists in the Submissions database.');
  }

  // If no duplicate in Submissions, check Archive sheet
  console.log("No duplicate in Submissions - checking Archive sheet...");
  const duplicateInArchive = await checkDuplicateInSheet(
    ARCHIVE_SHEET_ID,
    "Archive",
    partnerName,
    listingLink
  );

  if (duplicateInArchive) {
    throw new Error('Listing Link already exists in the Archived Submissions database.');
  }

  return false;
}

// Save Data to Submissions sheet
export async function saveData(data) {
  try {
    // Validate listing name length
    if (data.listingName && data.listingName.length > 180) {
      throw new Error('Listing Name must be 180 characters or less');
    }

    // Get or create Submissions sheet
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SUBMISSIONS_SHEET_ID,
    });

    let sheet = spreadsheet.data.sheets.find(
      (s) => s.properties.title === "Submissions",
    );

    if (!sheet) {
      // Create the sheet with headers
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SUBMISSIONS_SHEET_ID,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: "Submissions",
                },
              },
            },
          ],
        },
      });

      // Add headers
      await sheets.spreadsheets.values.update({
        spreadsheetId: SUBMISSIONS_SHEET_ID,
        range: "Submissions!A1:P1",
        valueInputOption: "RAW",
        requestBody: {
          values: [
            [
              "Submission ID",
              "Timestamp",
              "User Email",
              "Partner Name",
              "Listing Name",
              "Listing Link",
              "Brokerage",
              "Broker Name",
              "Broker Email",
              "Source Type",
              "Notes",
              "CIM Received",
              "Status",
              "Due Date",
              "Modified Date",
              "Sourcer Email",
            ],
          ],
        },
      });
    }

    // Get the last submission ID from the sheet
    const lastRowResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SUBMISSIONS_SHEET_ID,
      range: "Submissions!A:A",
    });

    const rows = lastRowResponse.data.values || [];
    let counter = 1;

    // Skip header row and find the last valid ID
    if (rows.length > 1) {
      const lastId = rows[rows.length - 1][0]; // Get last row's ID
      if (lastId && lastId.startsWith("SUB-")) {
        const lastNumber = parseInt(lastId.replace("SUB-", ""), 10);
        counter = lastNumber + 1;
      }
    }

    // Format ID: SUB-000001
    const id = "SUB-" + String(counter).padStart(6, "0");

    // Format timestamp in EST timezone
    const timestamp = new Date()
      .toLocaleString("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
      .replace(/(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/, "$3-$1-$2 $4:$5:$6");

    // Append new row
    const rowData = [
      id,
      timestamp,
      data.user,
      data.partner,
      data.listingName,
      data.listingLink,
      data.brokerage || "N/A",
      data.brokerName || "N/A",
      data.brokerEmail || "N/A",
      data.sourceType,
      data.notes || "",
      "FALSE", // CIM Received
      data.status || "", // Status
      "", // Due Date
      "", // Modified Date
      data.user, // Sourcer Email (same as User Email)
    ];
    
    console.log("Submitting data to Google Sheets:", rowData);
    console.log("CIM Received value (index 11):", rowData[11]);
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: SUBMISSIONS_SHEET_ID,
      range: "Submissions!A:P",
      valueInputOption: "RAW",
      requestBody: {
        values: [rowData],
      },
    });

    // Clear cache when new data is saved to ensure consistency
    clearCache();

    return { id };
  } catch (error) {
    console.error("Error saving data:", error);
    throw error;
  }
}

// Get User Submissions with pagination and filtering
export async function getUserSubmissions(email, page = 1, limit = 50, filters = {}) {
  try {
    // Check cache first
    const cacheKey = `submissions_${email}_${page}_${limit}_${JSON.stringify(filters)}`;
    const cached = getCache(cacheKey);
    if (cached) {
      console.log("Returning cached submissions for:", email);
      return cached;
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SUBMISSIONS_SHEET_ID,
      range: "Submissions!A:P",
    });

    const rows = response.data.values || [];

    // Skip header row
    const dataRows = rows.slice(1);

    // Filter by user email
    let filtered = dataRows.filter((row) => {
      const userEmail = String(row[2] || "").trim();
      return userEmail === email;
    });

    // Apply column filters
    if (filters.entryDate && filters.entryDate.length > 0) {
      filtered = filtered.filter((row) => {
        if (!row[1]) return filters.entryDate.includes('(Blank)');
        try {
          const dateStr = row[1].trim();
          const dateOnly = dateStr.split(' ')[0];
          const formattedDate = new Date(dateOnly).toLocaleDateString('en-CA');
          return filters.entryDate.includes(formattedDate);
        } catch (error) {
          return filters.entryDate.includes('Invalid Date');
        }
      });
    }

    if (filters.partner && filters.partner.length > 0) {
      filtered = filtered.filter((row) => {
        const value = row[3] || '(Blank)';
        return filters.partner.includes(value);
      });
    }

    if (filters.listingName && filters.listingName.length > 0) {
      filtered = filtered.filter((row) => {
        const value = row[4] || '(Blank)';
        return filters.listingName.includes(value);
      });
    }

    if (filters.sourceType && filters.sourceType.length > 0) {
      filtered = filtered.filter((row) => {
        const value = row[9] || '(Blank)';
        return filters.sourceType.includes(value);
      });
    }

    if (filters.status && filters.status.length > 0) {
      filtered = filtered.filter((row) => {
        const value = row[12] || '(Blank)';
        return filters.status.includes(value);
      });
    }

    const total = filtered.length;
    // Reverse to show newest first
    const reversed = filtered.reverse();
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedRows = reversed.slice(startIndex, endIndex);

    const submissions = paginatedRows.map((row) => ({
      submissionId: row[0],
      timestamp: row[1],
      partner: row[3],
      listingName: row[4],
      listingLink: row[5],
      brokerage: row[6],
      brokerName: row[7],
      brokerEmail: row[8],
      sourceType: row[9],
      notes: row[10],
      cimReceived: row[11],
      status: row[12],
      dueDate: row[13],
      modifiedDate: row[14],
      sourcerEmail: row[15],
    }));

    const result = { submissions, total, page, limit, totalPages: Math.ceil(total / limit) };
    setCache(cacheKey, result, SUBMISSIONS_CACHE_TTL);
    return result;
  } catch (error) {
    console.error("Error fetching submissions:", error);
    // Return empty if sheet doesn't exist yet
    return { submissions: [], total: 0, page, limit, totalPages: 0 };
  }
}

// Get All Submissions (for admin users) with pagination and filtering
export async function getAllSubmissions(page = 1, limit = 50, filters = {}) {
  try {
    // Check cache first
    const cacheKey = `allSubmissions_${page}_${limit}_${JSON.stringify(filters)}`;
    const cached = getCache(cacheKey);
    if (cached) {
      console.log("Returning cached all submissions");
      return cached;
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SUBMISSIONS_SHEET_ID,
      range: "Submissions!A:P",
    });

    const rows = response.data.values || [];

    // Skip header row
    let dataRows = rows.slice(1);

    // Apply column filters
    if (filters.entryDate && filters.entryDate.length > 0) {
      dataRows = dataRows.filter((row) => {
        if (!row[1]) return filters.entryDate.includes('(Blank)');
        try {
          const dateStr = row[1].trim();
          const dateOnly = dateStr.split(' ')[0];
          const formattedDate = new Date(dateOnly).toLocaleDateString('en-CA');
          return filters.entryDate.includes(formattedDate);
        } catch (error) {
          return filters.entryDate.includes('Invalid Date');
        }
      });
    }

    if (filters.partner && filters.partner.length > 0) {
      dataRows = dataRows.filter((row) => {
        const value = row[3] || '(Blank)';
        return filters.partner.includes(value);
      });
    }

    if (filters.listingName && filters.listingName.length > 0) {
      dataRows = dataRows.filter((row) => {
        const value = row[4] || '(Blank)';
        return filters.listingName.includes(value);
      });
    }

    if (filters.sourceType && filters.sourceType.length > 0) {
      dataRows = dataRows.filter((row) => {
        const value = row[9] || '(Blank)';
        return filters.sourceType.includes(value);
      });
    }

    if (filters.status && filters.status.length > 0) {
      dataRows = dataRows.filter((row) => {
        const value = row[12] || '(Blank)';
        return filters.status.includes(value);
      });
    }

    const total = dataRows.length;
    // Reverse to show newest first
    const reversed = dataRows.reverse();
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedRows = reversed.slice(startIndex, endIndex);

    const submissions = paginatedRows.map((row) => ({
      submissionId: row[0],
      timestamp: row[1],
      partner: row[3],
      listingName: row[4],
      listingLink: row[5],
      brokerage: row[6],
      brokerName: row[7],
      brokerEmail: row[8],
      sourceType: row[9],
      notes: row[10],
      cimReceived: row[11],
      status: row[12],
      dueDate: row[13],
      modifiedDate: row[14],
      sourcerEmail: row[15],
    }));

    const result = { submissions, total, page, limit, totalPages: Math.ceil(total / limit) };
    setCache(cacheKey, result, SUBMISSIONS_CACHE_TTL);
    return result;
  } catch (error) {
    console.error("Error fetching all submissions:", error);
    return { submissions: [], total: 0, page, limit, totalPages: 0 };
  }
}

// Get Filter Options (all unique values across all records)
export async function getFilterOptions(email) {
  try {
    // Check cache first
    const cacheKey = `filterOptions_${email || 'all'}`;
    const cached = getCache(cacheKey);
    if (cached) {
      console.log("Returning cached filter options for:", email);
      return cached;
    }

    console.log("Fetching filter options from sheet for:", email);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SUBMISSIONS_SHEET_ID,
      range: "Submissions!A:P",
    });

    const rows = response.data.values || [];

    // Skip header row
    const dataRows = rows.slice(1);

    // Filter by user email if not admin
    let filteredRows = dataRows;
    if (email && !['tanveer@regaliscapital.com', 'n8n@regaliscapital.com'].includes(email)) {
      filteredRows = dataRows.filter((row) => {
        const userEmail = String(row[2] || "").trim();
        return userEmail === email;
      });
    }

    // Extract unique values for each column
    const entryDates = new Set();
    const partners = new Set();
    const listingNames = new Set();
    const sourceTypes = new Set();
    const statuses = new Set();

    filteredRows.forEach((row) => {
      // Entry Date (column B, index 1)
      if (row[1]) {
        try {
          const dateStr = row[1].trim();
          const dateOnly = dateStr.split(' ')[0];
          const formattedDate = new Date(dateOnly).toLocaleDateString('en-CA');
          entryDates.add(formattedDate);
        } catch (error) {
          entryDates.add('Invalid Date');
        }
      } else {
        entryDates.add('(Blank)');
      }

      // Partner (column D, index 3)
      partners.add(row[3] || '(Blank)');

      // Listing Name (column E, index 4)
      listingNames.add(row[4] || '(Blank)');

      // Source Type (column K, index 9)
      sourceTypes.add(row[9] || '(Blank)');

      // Status (column M, index 12)
      statuses.add(row[12] || '(Blank)');
    });

    // Convert to arrays and sort
    const sortArray = (arr) => {
      const array = Array.from(arr);
      return array.sort((a, b) => {
        if (a === '(Blank)') return -1;
        if (b === '(Blank)') return 1;
        return a.localeCompare(b);
      });
    };

    const result = {
      entryDate: sortArray(entryDates),
      partner: sortArray(partners),
      listingName: sortArray(listingNames),
      sourceType: sortArray(sourceTypes),
      status: sortArray(statuses)
    };

    // Cache the result
    setCache(cacheKey, result);

    return result;
  } catch (error) {
    console.error("Error fetching filter options:", error);
    return {
      entryDate: [],
      partner: [],
      listingName: [],
      sourceType: [],
      status: []
    };
  }
}

// Update Submission
export async function updateSubmission(data) {
  try {
    console.log("Update submission data received:", data);
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SUBMISSIONS_SHEET_ID,
      range: "Submissions!A:P",
    });

    const rows = response.data.values || [];
    console.log("Sheet rows retrieved:", rows.length);
    console.log("Header row:", rows[0]);

    // Find the row index for the submission ID
    const rowIndex = rows.findIndex(
      (row, index) => index > 0 && row[0] === data.submissionId,
    );

    if (rowIndex === -1) {
      throw new Error("Submission not found");
    }

    console.log("Found submission at row index:", rowIndex, "row data:", rows[rowIndex]);
    console.log("Row length:", rows[rowIndex].length);

    // Ensure the row has enough columns (at least 16 for A-P)
    const currentRow = rows[rowIndex];
    while (currentRow.length < 16) {
      currentRow.push(''); // Add empty columns if missing
    }

    // Format current timestamp in EST for Modified Date
    const modifiedDate = new Date()
      .toLocaleString("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
      .replace(/(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/, "$3-$1-$2 $4:$5:$6");

    console.log("Updating with data:", {
      cimReceived: data.cimReceived,
      status: data.status,
      dueDate: data.dueDate,
      modifiedDate: modifiedDate
    });

    // Update CIM, Status, Due Date, and Modified Date (columns L-O)
    const updateRange = `Submissions!L${rowIndex + 1}:O${rowIndex + 1}`;
    console.log("Update range:", updateRange);
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SUBMISSIONS_SHEET_ID,
      range: updateRange,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          data.cimReceived, 
          data.status, 
          data.dueDate || '',
          modifiedDate
        ]],
      },
    });

    console.log("Columns L-O updated successfully");

    // Update notes in column K
    await sheets.spreadsheets.values.update({
      spreadsheetId: SUBMISSIONS_SHEET_ID,
      range: `Submissions!K${rowIndex + 1}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[data.notes]],
      },
    });

    // Clear cache when submission is updated to ensure consistency
    clearCache();

    return { success: true };
  } catch (error) {
    console.error("Error updating submission:", error);
    throw error;
  }
}

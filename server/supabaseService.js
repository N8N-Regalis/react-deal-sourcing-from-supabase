import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { getPartners } from './googleSheetsService.js';

dotenv.config();

// Initialize Supabase client with service role key for full access
function getSupabaseClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

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

// Get User Email (placeholder - in real app, this comes from auth)
export async function getUserEmail() {
  return process.env.USER_EMAIL || "";
}

// Helper function to check for duplicates in a specific table
async function checkDuplicateInTable(tableName, partnerName, listingLink) {
  try {
    // Normalize the listing link for comparison
    const normalizedListingLink = normalizeUrl(listingLink);
    
    // Clean partner name by removing special characters
    const cleanedPartnerName = partnerName.replace(/[❗⭐]/g, '').trim();

    console.log(`Checking for duplicate in ${tableName} table:`);
    console.log("Partner Name (cleaned):", cleanedPartnerName);
    console.log("Listing Link (normalized):", normalizedListingLink);

    // First filter by partner name
    const { data: partnerMatches, error: partnerError } = await getSupabaseClient()
      .from(tableName)
      .select('listing_link')
      .eq('partner_name', cleanedPartnerName);

    if (partnerError) {
      console.error(`Error querying ${tableName} by partner:`, partnerError);
      return false;
    }

    console.log(`Partner matches found in ${tableName}:`, partnerMatches?.length || 0);

    // If no partner matches, no need to check URLs
    if (!partnerMatches || partnerMatches.length === 0) {
      return false;
    }

    // Now check URL matches only for partner matches
    for (const row of partnerMatches) {
      const existingLink = row.listing_link;
      
      if (!existingLink) continue;
      
      // Normalize existing link for comparison
      let normalizedExistingLink;
      try {
        normalizedExistingLink = normalizeUrl(existingLink);
      } catch (error) {
        // If existing link is invalid, skip this row
        continue;
      }
      
      const linkMatch = normalizedExistingLink === normalizedListingLink;
      if (linkMatch) {
        console.log(`Duplicate found in ${tableName}`);
        return true;
      }
    }

    console.log(`No duplicate found in ${tableName}`);
    return false;
  } catch (error) {
    console.error(`Error checking duplicate in ${tableName}:`, error);
    return false;
  }
}

// Check if partner and listing link combination already exists in submissions table or archive table
export async function checkDuplicateSubmission(partnerName, listingLink) {
  console.log("Starting duplicate check...");

  // First check submissions table
  const duplicateInSubmissions = await checkDuplicateInTable(
    'submissions',
    partnerName,
    listingLink
  );

  // If duplicate found in submissions, throw error immediately (no need to check archive)
  if (duplicateInSubmissions) {
    console.log("Duplicate found in submissions table - skipping archive check");
    throw new Error('Listing Link already exists in the Submissions database.');
  }

  // If no duplicate in submissions, check archive table
  console.log("No duplicate in submissions - checking archive table...");
  const duplicateInArchive = await checkDuplicateInTable(
    'archive',
    partnerName,
    listingLink
  );

  if (duplicateInArchive) {
    throw new Error('Listing Link already exists in the Archived Submissions database.');
  }

  return false;
}

// Save Data to submissions table
export async function saveData(data) {
  try {
    // Validate listing name length
    if (data.listingName && data.listingName.length > 180) {
      throw new Error('Listing Name must be 180 characters or less');
    }

    // Get the last submission ID from the table
    const { data: lastSubmission, error: lastError } = await getSupabaseClient()
      .from('submissions')
      .select('id')
      .order('id', { ascending: false })
      .limit(1);

    let counter = 1;

    if (lastSubmission && lastSubmission.length > 0) {
      const lastId = lastSubmission[0].id;
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

    // Insert new row
    const rowData = {
      id,
      timestamp,
      user_email: data.user,
      partner_name: data.partner,
      listing_name: data.listingName,
      listing_link: data.listingLink,
      brokerage: data.brokerage || "N/A",
      broker_name: data.brokerName || "N/A",
      broker_email: data.brokerEmail || "N/A",
      source_type: data.sourceType,
      notes: data.notes || "",
      cim_received: false,
      status: data.status || "",
      due_date: null,
      modified_date: null,
      sourcer_email: data.user,
    };
    
    console.log("Submitting data to Supabase:", rowData);
    
    const { error } = await getSupabaseClient()
      .from('submissions')
      .insert(rowData);

    if (error) {
      console.error("Error inserting into Supabase:", error);
      throw error;
    }

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

    // Build query
    let query = getSupabaseClient()
      .from('submissions')
      .select('*', { count: 'exact' })
      .eq('user_email', email);

    // Apply filters
    if (filters.entryDate && filters.entryDate.length > 0) {
      query = query.in('timestamp', filters.entryDate);
    }

    if (filters.partner && filters.partner.length > 0) {
      query = query.in('partner_name', filters.partner);
    }

    if (filters.listingName && filters.listingName.length > 0) {
      query = query.in('listing_name', filters.listingName);
    }

    if (filters.sourceType && filters.sourceType.length > 0) {
      query = query.in('source_type', filters.sourceType);
    }

    if (filters.status && filters.status.length > 0) {
      query = query.in('status', filters.status);
    }

    // Calculate pagination
    const offset = (page - 1) * limit;
    
    // Order by timestamp descending (newest first)
    query = query.order('timestamp', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error("Error fetching submissions:", error);
      return { submissions: [], total: 0, page, limit, totalPages: 0 };
    }

    const submissions = (data || []).map((row) => ({
      submissionId: row.id,
      timestamp: row.timestamp,
      partner: row.partner_name,
      listingName: row.listing_name,
      listingLink: row.listing_link,
      brokerage: row.brokerage,
      brokerName: row.broker_name,
      brokerEmail: row.broker_email,
      sourceType: row.source_type,
      notes: row.notes,
      cimReceived: row.cim_received ? 'TRUE' : 'FALSE',
      status: row.status,
      dueDate: row.due_date,
      modifiedDate: row.modified_date,
      sourcerEmail: row.sourcer_email,
    }));

    const total = count || 0;
    const result = { submissions, total, page, limit, totalPages: Math.ceil(total / limit) };
    setCache(cacheKey, result, SUBMISSIONS_CACHE_TTL);
    return result;
  } catch (error) {
    console.error("Error fetching submissions:", error);
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

    // Build query
    let query = getSupabaseClient()
      .from('submissions')
      .select('*', { count: 'exact' });

    // Apply filters
    if (filters.entryDate && filters.entryDate.length > 0) {
      query = query.in('timestamp', filters.entryDate);
    }

    if (filters.partner && filters.partner.length > 0) {
      query = query.in('partner_name', filters.partner);
    }

    if (filters.listingName && filters.listingName.length > 0) {
      query = query.in('listing_name', filters.listingName);
    }

    if (filters.sourceType && filters.sourceType.length > 0) {
      query = query.in('source_type', filters.sourceType);
    }

    if (filters.status && filters.status.length > 0) {
      query = query.in('status', filters.status);
    }

    // Calculate pagination
    const offset = (page - 1) * limit;
    
    // Order by timestamp descending (newest first)
    query = query.order('timestamp', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error("Error fetching all submissions:", error);
      return { submissions: [], total: 0, page, limit, totalPages: 0 };
    }

    const submissions = (data || []).map((row) => ({
      submissionId: row.id,
      timestamp: row.timestamp,
      partner: row.partner_name,
      listingName: row.listing_name,
      listingLink: row.listing_link,
      brokerage: row.brokerage,
      brokerName: row.broker_name,
      brokerEmail: row.broker_email,
      sourceType: row.source_type,
      notes: row.notes,
      cimReceived: row.cim_received ? 'TRUE' : 'FALSE',
      status: row.status,
      dueDate: row.due_date,
      modifiedDate: row.modified_date,
      sourcerEmail: row.sourcer_email,
    }));

    const total = count || 0;
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

    console.log("Fetching filter options from Supabase for:", email);
    
    // Build query
    let query = getSupabaseClient().from('submissions').select('timestamp, partner_name, listing_name, source_type, status');

    // Filter by user email if not admin
    if (email && !['tanveer@regaliscapital.com', 'n8n@regaliscapital.com'].includes(email)) {
      query = query.eq('user_email', email);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Error fetching filter options:", error);
      return {
        entryDate: [],
        partner: [],
        listingName: [],
        sourceType: [],
        status: []
      };
    }

    const rows = data || [];

    // Extract unique values for each column
    const entryDates = new Set();
    const partners = new Set();
    const listingNames = new Set();
    const sourceTypes = new Set();
    const statuses = new Set();

    rows.forEach((row) => {
      // Entry Date (timestamp)
      if (row.timestamp) {
        try {
          const dateStr = row.timestamp.trim();
          const dateOnly = dateStr.split(' ')[0];
          const formattedDate = new Date(dateOnly).toLocaleDateString('en-CA');
          entryDates.add(formattedDate);
        } catch (error) {
          entryDates.add('Invalid Date');
        }
      } else {
        entryDates.add('(Blank)');
      }

      // Partner (partner_name)
      partners.add(row.partner_name || '(Blank)');

      // Listing Name (listing_name)
      listingNames.add(row.listing_name || '(Blank)');

      // Source Type (source_type)
      sourceTypes.add(row.source_type || '(Blank)');

      // Status (status)
      statuses.add(row.status || '(Blank)');
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

    const { error } = await getSupabaseClient()
      .from('submissions')
      .update({
        cim_received: data.cimReceived === 'TRUE',
        status: data.status,
        due_date: data.dueDate || null,
        modified_date: modifiedDate,
        notes: data.notes
      })
      .eq('id', data.submissionId);

    if (error) {
      console.error("Error updating submission:", error);
      throw error;
    }

    console.log("Submission updated successfully");

    // Clear cache when submission is updated to ensure consistency
    clearCache();

    return { success: true };
  } catch (error) {
    console.error("Error updating submission:", error);
    throw error;
  }
}

// Get Partners - keep using Google Sheets
export { getPartners };

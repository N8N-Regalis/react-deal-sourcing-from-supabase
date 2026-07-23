import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getPartners } from './googleSheetsService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });
dotenv.config({ path: join(__dirname, '.env') });

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

export function clearCache() {
  cache.clear();
}

// Search listing links across all submissions
export async function searchListingLinks(email, searchTerm) {
  try {
    // console.log("Searching listing links for:", email, "search:", searchTerm);
    
    // Build query to search for listing links that match the search term
    let query = getSupabaseClient()
      .from('submissions')
      .select('listing_link')
      .ilike('listing_link', `%${searchTerm}%`);

    // Filter by user email if not admin
    if (email && !['tanveer@regaliscapital.com', 'n8n@regaliscapital.com'].includes(email)) {
      query = query.eq('user_email', email);
    }

    // Limit results to prevent performance issues
    query = query.limit(100);

    const { data, error } = await query;

    if (error) {
      console.error("Error searching listing links:", error);
      return [];
    }

    // Extract unique links
    const uniqueLinks = [...new Set(data?.map(row => row.listing_link).filter(Boolean) || [])];
    
    // console.log(`Found ${uniqueLinks.length} matching links for search: "${searchTerm}"`);
    
    return uniqueLinks;
  } catch (error) {
    console.error("Error searching listing links:", error);
    return [];
  }
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

    // Extract a unique identifier from the URL for initial filtering (e.g., the path after domain)
    const urlIdentifier = normalizedListingLink.split('/').slice(-2).join('/');

    // Filter by both partner name and listing link pattern to reduce result set
    const { data: matches, error: queryError } = await getSupabaseClient()
      .from(tableName)
      .select('listing_link')
      .eq('partner_name', cleanedPartnerName)
      .ilike('listing_link', `%${urlIdentifier}%`);

    if (queryError) {
      console.error(`Error querying ${tableName}:`, queryError);
      return false;
    }

    console.log(`Matches found in ${tableName}:`, matches?.length || 0);

    // If no matches, no need to check URLs
    if (!matches || matches.length === 0) {
      return false;
    }

    // Now check URL matches only for partner matches
    for (const row of matches) {
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
      
      // Debug logging for specific URLs
      if (existingLink.includes('2522867') || existingLink.includes('siomai')) {
        console.log("Comparing with existing link:", existingLink);
        console.log("Normalized existing link:", normalizedExistingLink);
        console.log("Normalized input link:", normalizedListingLink);
        console.log("Match result:", linkMatch);
      }
      
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
      // Use RPC to handle date filtering with proper SQL casting
      const isAdmin = email && ['tanveer@regaliscapital.com', 'n8n@regaliscapital.com'].includes(email);
      const rpcEmail = isAdmin ? null : email;
      
      const { data: rpcData, error: rpcError } = await getSupabaseClient()
        .rpc('get_submissions_with_date_filter', { 
          p_email: rpcEmail,
          p_entry_dates: filters.entryDate,
          p_partner_names: filters.partner || [],
          p_listing_names: filters.listingName || [],
          p_source_types: filters.sourceType || [],
          p_statuses: filters.status || [],
          p_listing_links: filters.listingLink || [],
          p_offset: (page - 1) * limit,
          p_limit: limit
        });
      
      if (rpcError) {
        console.error("Error fetching submissions via RPC:", rpcError);
        // Fallback to regular query without date filter
        console.log("Falling back to regular query without date filter");
      } else {
        // Process RPC results
        const submissions = (rpcData || []).map((row) => ({
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

        // Get total count - RPC returns scalar in data, not count
        const { data: countData } = await getSupabaseClient()
          .rpc('count_submissions_with_date_filter', { 
            p_email: rpcEmail,
            p_entry_dates: filters.entryDate,
            p_partner_names: filters.partner || [],
            p_listing_names: filters.listingName || [],
            p_source_types: filters.sourceType || [],
            p_statuses: filters.status || [],
            p_listing_links: filters.listingLink || []
          });

        const total = countData || 0;
        const result = { submissions, total, page, limit, totalPages: Math.ceil(total / limit) };
        setCache(cacheKey, result, SUBMISSIONS_CACHE_TTL);
        return result;
      }
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

    if (filters.listingLink && filters.listingLink.length > 0) {
      // console.log("Applying listingLink filter:", filters.listingLink);
      query = query.in('listing_link', filters.listingLink);
    }

    // Calculate pagination
    const offset = (page - 1) * limit;
    
    // Order by timestamp descending (newest first)
    query = query.order('timestamp', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    // console.log("Query executed with filters:", filters);
    // console.log("Query results - data length:", data?.length || 0);
    // console.log("Query results - total count:", count);
    // console.log("Query results - sample data:", data?.slice(0, 2));

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
      return cached;
    }

    // Build query
    let query = getSupabaseClient()
      .from('submissions')
      .select('*', { count: 'exact' });

    // Apply filters
    if (filters.entryDate && filters.entryDate.length > 0) {
      // Clear cache when date filters are present to ensure fresh data
      clearCache();
      
      // Use RPC to handle date filtering with proper SQL casting
      // getAllSubmissions is for admin users, so email is always null
      
      const { data: rpcData, error: rpcError } = await getSupabaseClient()
        .rpc('get_submissions_with_date_filter', { 
          p_email: null,
          p_entry_dates: filters.entryDate,
          p_partner_names: filters.partner || [],
          p_listing_names: filters.listingName || [],
          p_source_types: filters.sourceType || [],
          p_statuses: filters.status || [],
          p_listing_links: filters.listingLink || [],
          p_offset: (page - 1) * limit,
          p_limit: limit
        });
      
      if (rpcError) {
        console.error("Error fetching submissions via RPC:", rpcError);
        // Fallback to regular query without date filter
        console.log("Falling back to regular query without date filter");
      } else {
        // Process RPC results
        const submissions = (rpcData || []).map((row) => ({
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

        // Get total count - RPC returns scalar in data, not count
        const { data: countData } = await getSupabaseClient()
          .rpc('count_submissions_with_date_filter', { 
            p_email: null,
            p_entry_dates: filters.entryDate,
            p_partner_names: filters.partner || [],
            p_listing_names: filters.listingName || [],
            p_source_types: filters.sourceType || [],
            p_statuses: filters.status || [],
            p_listing_links: filters.listingLink || []
          });

        const total = countData || 0;
        const result = { submissions, total, page, limit, totalPages: Math.ceil(total / limit) };
        setCache(cacheKey, result, SUBMISSIONS_CACHE_TTL);
        return result;
      }
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

    if (filters.listingLink && filters.listingLink.length > 0) {
      // console.log("Applying listingLink filter in getAllSubmissions:", filters.listingLink);
      query = query.in('listing_link', filters.listingLink);
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

// Get Filter Options (all unique values via Supabase RPC for performance)
export async function getFilterOptions(email) {
  try {
    // Check cache first
    const cacheKey = `filterOptions_${email || 'all'}`;
    const cached = getCache(cacheKey);
    if (cached) {
      console.log("Returning cached filter options for:", email);
      return cached;
    }

    // Pass null for admin users to get all records
    const isAdmin = email && ['tanveer@regaliscapital.com', 'n8n@regaliscapital.com'].includes(email);
    const rpcEmail = isAdmin ? null : email;

    const { data, error } = await getSupabaseClient()
      .rpc('get_filter_options', { p_email: rpcEmail });

    if (error) {
      console.error("Error fetching filter options via RPC:", error);
      return {
        entryDate: [],
        partner: [],
        listingName: [],
        sourceType: [],
        status: [],
        listingLink: []
      };
    }

    const result = {
      entryDate: data.entryDate || [],
      partner: data.partner || [],
      listingName: data.listingName || [],
      sourceType: data.sourceType || [],
      status: data.status || [],
      listingLink: [] // Handled client-side via search
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
      status: [],
      listingLink: []
    };
  }
}

// Update Submission
export async function updateSubmission(data) {
  try {
    console.log("Update submission data received:", data);
    
    // Clean partner name by removing special characters
    const cleanedPartnerName = data.partner ? data.partner.replace(/[❗⭐]/g, '').trim() : data.partner;
    
    // Fetch current submission to get listing link
    const { data: currentSubmission, error: fetchError } = await getSupabaseClient()
      .from('submissions')
      .select('partner_name, listing_link')
      .eq('id', data.submissionId)
      .single();
    
    if (fetchError) {
      console.error("Error fetching current submission:", fetchError);
      throw new Error('Failed to fetch current submission');
    }
    
    // Check if partner name is changing
    if (currentSubmission.partner_name !== cleanedPartnerName) {
      console.log("Partner name is changing, checking for duplicates...");
      console.log("Old partner:", currentSubmission.partner_name);
      console.log("New partner:", cleanedPartnerName);
      console.log("Listing link:", currentSubmission.listing_link);
      
      // Check for duplicate in submissions table (excluding current submission)
      const duplicateInSubmissions = await checkDuplicateExcludingId(
        'submissions',
        cleanedPartnerName,
        currentSubmission.listing_link,
        data.submissionId
      );
      
      if (duplicateInSubmissions) {
        throw new Error(`Duplicate entry: Client "${cleanedPartnerName}" already has this listing link in the Submissions database.`);
      }
      
      // Check for duplicate in archive table
      const duplicateInArchive = await checkDuplicateInTable(
        'archive',
        cleanedPartnerName,
        currentSubmission.listing_link
      );
      
      if (duplicateInArchive) {
        throw new Error(`Duplicate entry: Client "${cleanedPartnerName}" already has this listing link in the Archived Submissions database.`);
      }
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
      partner: cleanedPartnerName,
      cimReceived: data.cimReceived,
      status: data.status,
      dueDate: data.dueDate,
      modifiedDate: modifiedDate
    });

    const { error, data: updateData } = await getSupabaseClient()
      .from('submissions')
      .update({
        partner_name: cleanedPartnerName,
        cim_received: data.cimReceived === 'TRUE',
        status: data.status,
        due_date: data.dueDate || null,
        modified_date: modifiedDate,
        notes: data.notes
      })
      .eq('id', data.submissionId)
      .select();

    if (error) {
      console.error("Error updating submission:", error);
      throw error;
    }

    // console.log("Submission updated successfully. Updated data:", updateData);

    // Clear cache when submission is updated to ensure consistency
    clearCache();

    return { success: true };
  } catch (error) {
    console.error("Error updating submission:", error);
    throw error;
  }
}

// Helper function to check for duplicates excluding a specific ID
async function checkDuplicateExcludingId(tableName, partnerName, listingLink, excludeId) {
  try {
    // Normalize the listing link for comparison
    const normalizedListingLink = normalizeUrl(listingLink);
    
    // Clean partner name by removing special characters
    const cleanedPartnerName = partnerName.replace(/[❗⭐]/g, '').trim();

    console.log(`Checking for duplicate in ${tableName} table (excluding ID: ${excludeId}):`);
    console.log("Partner Name (cleaned):", cleanedPartnerName);
    console.log("Listing Link (normalized):", normalizedListingLink);

    // Extract a unique identifier from the URL for initial filtering
    const urlIdentifier = normalizedListingLink.split('/').slice(-2).join('/');

    // Filter by both partner name and listing link pattern, excluding the current ID
    const { data: matches, error: queryError } = await getSupabaseClient()
      .from(tableName)
      .select('listing_link, id')
      .eq('partner_name', cleanedPartnerName)
      .ilike('listing_link', `%${urlIdentifier}%`)
      .neq('id', excludeId);

    if (queryError) {
      console.error(`Error querying ${tableName}:`, queryError);
      return false;
    }

    console.log(`Matches found in ${tableName}:`, matches?.length || 0);

    // If no matches, no need to check URLs
    if (!matches || matches.length === 0) {
      return false;
    }

    // Now check URL matches only for partner matches
    for (const row of matches) {
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

// Get Partners - keep using Google Sheets
export { getPartners };

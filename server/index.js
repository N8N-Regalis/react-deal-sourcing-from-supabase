import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// Load environment variables first
// Loads root .env then server/.env (server/.env takes precedence); on Railway, env vars are injected automatically
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: join(__dirname, '..', '.env') })
dotenv.config({ path: join(__dirname, '.env') })

// Now import services that depend on environment variables
import { getPartners } from './googleSheetsService.js'
import { getUserEmail, saveData, getUserSubmissions, updateSubmission, checkDuplicateSubmission, getAllSubmissions, normalizeUrl, getFilterOptions, clearCache } from './supabaseService.js'

const app = express()
const PORT = process.env.PORT || 5000

app.use(cors({
  origin: true,
  credentials: true
}))
app.use(express.json())

// API Routes
app.get('/api/partners', async (req, res) => {
  try {
    const partners = await getPartners()
    res.json(partners)
  } catch (error) {
    console.error('Error fetching partners:', error)
    res.status(500).json({ error: 'Failed to fetch partners' })
  }
})

app.get('/api/user', async (req, res) => {
  try {
    const email = await getUserEmail()
    res.json({ email })
  } catch (error) {
    console.error('Error fetching user email:', error)
    res.json({ email: '' })
  }
})

app.post('/api/submit', async (req, res) => {
  try {
    const { partner, listingLink, sourceType } = req.body
    
    // Validate required fields
    if (!partner || !listingLink) {
      return res.status(400).json({ error: 'Partner and listing link are required' })
    }
    
    // Normalize the listing link for duplicate checking
    let normalizedListingLink
    try {
      normalizedListingLink = normalizeUrl(listingLink)
    } catch (error) {
      return res.status(400).json({ error: 'Invalid listing link URL' })
    }
    
    // Skip duplicate check if sourceType is "Resourced"
    if (sourceType !== "Resourced") {
      // Check if partner and listing link combination already exists
      const exists = await checkDuplicateSubmission(partner, normalizedListingLink)
      if (exists) {
        return res.status(409).json({ error: 'Listing Link already exists' })
      }
    }
    
    const result = await saveData(req.body)
    res.json(result)
  } catch (error) {
    // Log simpler message for duplicate errors
    if (error.message.includes('already exists')) {
      console.log('Duplicate detected:', error.message)
    } else {
      console.error('Error saving data:', error)
    }
    res.status(400).json({ error: error.message || 'Failed to save data' })
  }
})

const ADMIN_EMAILS = ['tanveer@regaliscapital.com', 'n8n@regaliscapital.com']

app.get('/api/submissions', async (req, res) => {
  try {
    const { email, page = 1, limit = 50, filters } = req.query
    // console.log('Submissions endpoint called:', { email, page, limit, filters });
    
    if (!email) {
      return res.status(400).json({ error: 'Email parameter required' })
    }
    
    const pageNum = parseInt(page, 10)
    const limitNum = parseInt(limit, 10)
    const filtersObj = filters ? JSON.parse(filters) : {}
    
    // console.log('Parsed filters:', filtersObj);
    // console.log('Is admin:', ADMIN_EMAILS.includes(email));
    
    // Check if user is admin
    if (ADMIN_EMAILS.includes(email)) {
      // console.log('Calling getAllSubmissions');
      const data = await getAllSubmissions(pageNum, limitNum, filtersObj)
      res.json(data)
    } else {
      // console.log('Calling getUserSubmissions');
      const data = await getUserSubmissions(email, pageNum, limitNum, filtersObj)
      res.json(data)
    }
  } catch (error) {
    console.error('Error fetching submissions:', error)
    res.json({ submissions: [], total: 0, page: 1, limit: 50, totalPages: 0 })
  }
})

app.put('/api/update-submission', async (req, res) => {
  try {
    const result = await updateSubmission(req.body)
    res.json(result)
  } catch (error) {
    console.error('Error updating submission:', error)
    res.status(500).json({ error: 'Failed to update submission' })
  }
})

app.get('/api/filter-options', async (req, res) => {
  try {
    const { email } = req.query
    if (!email) {
      return res.status(400).json({ error: 'Email parameter required' })
    }
    
    const options = await getFilterOptions(email)
    res.json(options)
  } catch (error) {
    console.error('Error fetching filter options:', error)
    res.status(500).json({ error: 'Failed to fetch filter options' })
  }
})

// Temporary endpoint to clear cache for debugging
app.post('/api/clear-cache', (req, res) => {
  try {
    // console.log('Cache clear endpoint called')
    clearCache()
    // console.log('Cache cleared successfully')
    res.json({ message: 'Cache cleared successfully' })
  } catch (error) {
    console.error('Error clearing cache:', error)
    res.status(500).json({ error: 'Failed to clear cache' })
  }
})

// Search endpoint for LINK filter
app.get('/api/search-links', async (req, res) => {
  try {
    const { email, search } = req.query
    if (!search) {
      return res.json([])
    }
    
    const { searchListingLinks } = await import('./supabaseService.js')
    const results = await searchListingLinks(email, search)
    res.json(results)
  } catch (error) {
    console.error('Error searching links:', error)
    res.status(500).json({ error: 'Failed to search links' })
  }
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

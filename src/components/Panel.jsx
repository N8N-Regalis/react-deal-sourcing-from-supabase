import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import './Panel.css'

const Panel = ({ submissions, onRefresh, pagination, onPageChange, filterOptions, onFilterChange, userEmail }) => {
  const [expandedRows, setExpandedRows] = useState(new Set())
  const [editingRow, setEditingRow] = useState(null)
  const [editFormData, setEditFormData] = useState({})
  const [sortBy, setSortBy] = useState('entryDate')
  const [sortOrder, setSortOrder] = useState('desc')
  const [filters, setFilters] = useState({
    entryDate: [],
    partner: [],
    listingName: [],
    sourceType: [],
    status: [],
    listingLink: []
  })
  const [activeFilterDropdown, setActiveFilterDropdown] = useState(null)
  const [filterSearch, setFilterSearch] = useState('')
  const [debouncedFilterSearch, setDebouncedFilterSearch] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 })
  const dropdownRefs = useRef({})

  const statusOptions = [
    'Inquired',
    'Pending NDA',
    'NDA Signed', 
    'Follow up',
    'For Broker Intro Call',
    'Added in Bitrix',
    'Axed'
  ]

  const columnConfig = [
    { key: 'entryDate', label: 'Entry Date', accessor: 'timestamp' },
    { key: 'partner', label: 'Client', accessor: 'partner' },
    { key: 'listingName', label: 'Listing Name', accessor: 'listingName' },
    { key: 'sourceType', label: 'Type', accessor: 'sourceType' },
    { key: 'status', label: 'Status', accessor: 'status' },
    { key: 'listingLink', label: 'Link', accessor: 'listingLink' }
  ]

  const isDueToday = (dueDate) => {
    if (!dueDate) return false;
    
    // Get today's date in EST
    const today = new Date();
    const todayEST = new Date(today.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const todayString = todayEST.toISOString().split('T')[0]; // YYYY-MM-DD format
    
    // Check if today's date equals due date OR is past the due date
    return dueDate <= todayString;
  }

  const toggleRow = (submissionId) => {
    const newExpanded = new Set(expandedRows)
    if (newExpanded.has(submissionId)) {
      newExpanded.delete(submissionId)
    } else {
      newExpanded.add(submissionId)
    }
    setExpandedRows(newExpanded)
  }

  const startEdit = (submission) => {
    setEditingRow(submission.submissionId)
    setEditFormData({
      cimReceived: submission.cimReceived || 'FALSE',
      status: submission.status || '',
      notes: submission.notes || '',
      dueDate: submission.dueDate || ''
    })
  }

  const cancelEdit = () => {
    setEditingRow(null)
    setEditFormData({})
  }

  const saveEdit = async () => {
    try {
      const apiUrl = import.meta.env.VITE_API_URL || "/api";
      const response = await fetch(`${apiUrl}/update-submission`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          submissionId: editingRow,
          cimReceived: editFormData.cimReceived,
          status: editFormData.status,
          notes: editFormData.notes,
          dueDate: editFormData.dueDate
        })
      })

      if (response.ok) {
        setEditingRow(null)
        setEditFormData({})
        onRefresh(pagination?.page || 1, filters, pagination?.limit || 50) // Refresh the current page with filters
      } else {
        console.error('Failed to update submission')
      }
    } catch (error) {
      console.error('Error updating submission:', error)
    }
  }

  const handleEditChange = (field, value) => {
    setEditFormData(prev => ({
      ...prev,
      [field]: value
    }))
  }

  const sortOptions = [
    { value: 'partnerName', label: 'Client Name' },
    { value: 'listingName', label: 'Listing Name' },
    { value: 'entryDate', label: 'Entry Date' },
    { value: 'dueDate', label: 'Due Date' },
    { value: 'status', label: 'Status' }
  ]

  const parseDate = (dateStr) => {
    if (!dateStr) return new Date(0);
    try {
      // Handle both Google Sheets (YYYY-MM-DD HH:MM:SS) and Supabase ISO (YYYY-MM-DDTHH:MM:SSZ) formats
      const trimmedStr = dateStr.trim();
      
      // For ISO timestamps, parse directly - Date constructor handles them well
      if (trimmedStr.includes('T')) {
        return new Date(trimmedStr);
      }
      
      // For Google Sheets format, extract date part and parse
      const dateOnly = trimmedStr.split(' ')[0];
      return new Date(dateOnly);
    } catch (error) {
      console.error('Error parsing date:', dateStr, error);
      return new Date(0);
    }
  }

  // Use global filter options from server instead of building from current page
  const uniqueValuesCache = useMemo(() => {
    const cache = {}
    columnConfig.forEach(column => {
      cache[column.key] = filterOptions?.[column.key] || []
    })
    
        
    return cache
  }, [filterOptions])

  // Apply sorting to submissions (filtering is now server-side)
  const getSortedSubmissions = useMemo(() => {
    const sorted = [...submissions].sort((a, b) => {
      let aValue, bValue;

      switch (sortBy) {
        case 'partnerName':
          aValue = a.partner || '';
          bValue = b.partner || '';
          return aValue.localeCompare(bValue);
        case 'listingName':
          aValue = a.listingName || '';
          bValue = b.listingName || '';
          return aValue.localeCompare(bValue);
        case 'entryDate':
          aValue = parseDate(a.timestamp);
          bValue = parseDate(b.timestamp);
          return aValue - bValue;
        case 'dueDate':
          aValue = parseDate(a.dueDate);
          bValue = parseDate(b.dueDate);
          return aValue - bValue;
        case 'status':
          aValue = a.status || '';
          bValue = b.status || '';
          return aValue.localeCompare(bValue);
        default:
          return 0;
      }
    });

    return sortOrder === 'asc' ? sorted : sorted.reverse();
  }, [submissions, sortBy, sortOrder])

  const toggleFilterDropdown = (columnKey, event) => {
    if (activeFilterDropdown === columnKey) {
      setActiveFilterDropdown(null)
      setFilterSearch('')
      setDebouncedFilterSearch('')
    } else {
      setActiveFilterDropdown(columnKey)
      setFilterSearch('')
      setDebouncedFilterSearch('')
      
      // Calculate position for fixed dropdown with scroll compensation
      const button = event.target
      const headerCell = button.closest('th')
      const headerRect = headerCell.getBoundingClientRect()
      
      // Use viewport coordinates for fixed positioning
      let left = headerRect.left
      let top = headerRect.bottom + 4
      
      // Boundary checking within viewport
      const dropdownWidth = 300
      const windowWidth = window.innerWidth
      
      if (left + dropdownWidth > windowWidth) {
        left = windowWidth - dropdownWidth - 10
      }
      
      if (left < 10) {
        left = 10
      }
      
      setDropdownPosition({ top, left })
    }
  }

  const handleFilterChange = (columnKey, value) => {
    // console.log('handleFilterChange called:', { columnKey, value });
    setFilters(prev => {
      const currentFilters = prev[columnKey] || []
      let newFilters

      if (currentFilters.includes(value)) {
        newFilters = currentFilters.filter(f => f !== value)
      } else {
        newFilters = [...currentFilters, value]
      }

      const newFiltersState = {
        ...prev,
        [columnKey]: newFilters
      }

      // console.log('New filters state:', newFiltersState);
      // console.log('Calling onFilterChange with new filters');

      // Trigger server-side filtering
      onFilterChange(newFiltersState)

      return newFiltersState
    })
  }

  const clearColumnFilter = (columnKey) => {
    const newFiltersState = {
      ...filters,
      [columnKey]: []
    }
    setFilters(newFiltersState)
    onFilterChange(newFiltersState)
  }

  const clearAllFilters = () => {
    const newFiltersState = {
      entryDate: [],
      partner: [],
      listingName: [],
      sourceType: [],
      status: [],
      listingLink: []
    }
    setFilters(newFiltersState)
    onFilterChange(newFiltersState)
  }

  const selectAllInColumn = (columnKey) => {
    const allValues = filterOptions[columnKey] || []
    const newFiltersState = {
      ...filters,
      [columnKey]: allValues
    }
    setFilters(newFiltersState)
    onFilterChange(newFiltersState)
  }

  const getFilteredValues = useCallback((columnKey, searchValue) => {
    // For other columns, use the existing filter options
    const allValues = uniqueValuesCache[columnKey] || []
    if (!searchValue) return allValues
    
    // Instant filtering without debounce
    return allValues.filter(value => 
      value.toLowerCase().includes(searchValue.toLowerCase())
    )
  }, [uniqueValuesCache])

  // Handle clicks outside filter dropdowns
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (activeFilterDropdown && dropdownRefs.current[activeFilterDropdown]) {
        const dropdownElement = dropdownRefs.current[activeFilterDropdown]
        if (!dropdownElement.contains(event.target)) {
          setActiveFilterDropdown(null)
          setFilterSearch('')
          setDebouncedFilterSearch('')
        }
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [activeFilterDropdown])

  const FilterDropdown = React.memo(({ columnKey }) => {
    const [localFilterSearch, setLocalFilterSearch] = useState('')
    const [searchResults, setSearchResults] = useState([])
    const [isSearching, setIsSearching] = useState(false)
    const column = columnConfig.find(col => col.key === columnKey)
    const allValues = uniqueValuesCache[columnKey] || []
    const filteredValues = getFilteredValues(columnKey, localFilterSearch)
    const selectedValues = filters[columnKey] || []
    const isActive = activeFilterDropdown === columnKey
    
    // Handle LINK search
    const handleLinkSearch = useCallback(async (searchValue) => {
      if (columnKey !== 'listingLink') return
      
      if (!searchValue) {
        setSearchResults([])
        setIsSearching(false)
        return
      }
      
      setIsSearching(true)
      
      try {
        const apiUrl = import.meta.env.VITE_API_URL || "/api";
        const response = await fetch(
          `${apiUrl}/search-links?email=${encodeURIComponent(userEmail)}&search=${encodeURIComponent(searchValue)}`
        );
        
        if (!response.ok) {
          console.error('Error searching links:', response.statusText);
          setSearchResults([])
          setIsSearching(false)
          return
        }
        
        const results = await response.json();
        // console.log('LINK filter search (searchValue):', searchValue);
        // console.log('Found matching links:', results.length);
        // console.log('Matching links:', results);
        
        // Check if the specific URL we're looking for is found
        // const testUrl = 'https://www.bizbuysell.com/business-opportunity/profitable-seasonal-boat-rental-business-for-sale-high-margins/2346198/'
        // const foundTestUrl = results.includes(testUrl)
        // console.log('Test URL found in results:', foundTestUrl)
        
        setSearchResults(results)
        setIsSearching(false)
      } catch (error) {
        console.error('Error searching links:', error);
        setSearchResults([])
        setIsSearching(false)
      }
    }, [columnKey, userEmail])
    
    // Debounced search for LINK
    useEffect(() => {
      if (columnKey === 'listingLink') {
        const timeoutId = setTimeout(() => {
          handleLinkSearch(localFilterSearch)
        }, 300)
        
        return () => clearTimeout(timeoutId)
      }
    }, [localFilterSearch, columnKey, handleLinkSearch])
    
    if (!isActive) return null
    
    // Handle LINK column differently - use search results or empty
    let displayValues
    if (columnKey === 'listingLink') {
      displayValues = localFilterSearch ? searchResults : []
    } else {
      displayValues = localFilterSearch ? filteredValues : allValues
    }
    
    return (
      <div 
        ref={(el) => dropdownRefs.current[columnKey] = el}
        className="filter-dropdown"
      >
        <div className="filter-search">
          <input
            type="text"
            placeholder="Search values..."
            value={localFilterSearch}
            onChange={(e) => {
              const value = e.target.value
              setLocalFilterSearch(value)
            }}
            className="filter-search-input"
          />
          {columnKey === 'listingLink' && isSearching && (
            <div className="search-loading">Searching...</div>
          )}
        </div>
        
        <div className="filter-actions">
          <button 
            className="filter-action-btn"
            onClick={() => selectAllInColumn(columnKey)}
          >
            Select All
          </button>
          <button 
            className="filter-action-btn"
            onClick={() => clearColumnFilter(columnKey)}
          >
            Clear
          </button>
        </div>
        
        <div className="filter-options">
          {displayValues.map(value => (
            <label key={value} className="filter-option">
              <input
                type="checkbox"
                checked={selectedValues.includes(value)}
                onChange={() => handleFilterChange(columnKey, value)}
              />
              <span className="filter-option-text">{value}</span>
            </label>
          ))}
        </div>
      </div>
    )
  })

  const getFilteredAndSortedSubmissions = useMemo(() => {
    let filtered = submissions.filter(submission => {
      // Check each column filter
      for (const column of columnConfig) {
        const columnFilters = filters[column.key] || []
        if (columnFilters.length === 0) continue // No filter for this column
        
        let value = submission[column.accessor]
        
        // Special handling for entry date
        if (column.key === 'entryDate' && value) {
          try {
            const dateStr = value.trim()
            const dateOnly = dateStr.split(' ')[0]
            value = new Date(dateOnly).toLocaleDateString('en-CA')
          } catch (error) {
            value = 'Invalid Date'
          }
        }
        
        const displayValue = value || '(Blank)'
        
        if (!columnFilters.includes(displayValue)) {
          return false
        }
      }
      
      return true
    })

    // Apply sorting to filtered results
    const sorted = filtered.sort((a, b) => {
      let aValue, bValue;
      
      switch (sortBy) {
        case 'partnerName':
          aValue = a.partner || '';
          bValue = b.partner || '';
          return aValue.localeCompare(bValue);
        case 'listingName':
          aValue = a.listingName || '';
          bValue = b.listingName || '';
          return aValue.localeCompare(bValue);
        case 'entryDate':
          aValue = parseDate(a.timestamp);
          bValue = parseDate(b.timestamp);
          return aValue - bValue;
        case 'dueDate':
          aValue = parseDate(a.dueDate);
          bValue = parseDate(b.dueDate);
          return aValue - bValue;
        case 'status':
          aValue = a.status || '';
          bValue = b.status || '';
          return aValue.localeCompare(bValue);
        default:
          return 0;
      }
    });

    return sortOrder === 'asc' ? sorted : sorted.reverse();
  }, [submissions, filters, sortBy, sortOrder])
  return (
    <div className="panel">
      <div className="panel-header">
        <h3>My Sourced Deals</h3>
        <button
          className="refresh-btn"
          onClick={async () => {
            setIsRefreshing(true)
            try {
              await onRefresh(pagination?.page || 1, filters, pagination?.limit || 50)
            } finally {
              setIsRefreshing(false)
            }
          }}
          disabled={isRefreshing}
          title={isRefreshing ? "Refreshing..." : "Refresh submissions"}
        >
          {isRefreshing ? '⟳ Refreshing...' : '↻ Refresh'}
        </button>
      </div>

      <div className="sort-section">
        <button 
          className="clear-filters-btn"
          onClick={clearAllFilters}
          title="Clear all filters"
        >
          Clear All Filters
        </button>
        <div className="sort-controls">
          <label className="sort-label">Sort By:</label>
          <select 
            className="sort-dropdown"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            {sortOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button 
            className="sort-order-btn"
            onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
            title={`Sort ${sortOrder === 'asc' ? 'Descending' : 'Ascending'}`}
          >
            {sortOrder === 'asc' ? '↑' : '↓'}
          </button>
        </div>
      </div>

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              {columnConfig.map(column => {
                const hasFilter = filters[column.key] && filters[column.key].length > 0
                return (
                  <th key={column.key} className="filterable-header">
                    <div className="header-content">
                      <span className="header-text">{column.label}</span>
                      <button 
                        className={`filter-btn ${hasFilter ? 'active' : ''}`}
                        onClick={(e) => toggleFilterDropdown(column.key, e)}
                        title="Filter this column"
                      >
                        ▼
                      </button>
                    </div>
                  </th>
                )
              })}
              <th className="action-header">Edit</th>
            </tr>
          </thead>
          <tbody>
            {getFilteredAndSortedSubmissions.length === 0 ? (
              <tr>
                <td colSpan="7" style={{ textAlign: 'center', padding: '20px' }}>
                  No submissions yet
                </td>
              </tr>
            ) : (
              getFilteredAndSortedSubmissions.map((submission) => (
                <React.Fragment key={submission.submissionId}>
                  <tr 
                    className={`clickable-row ${isDueToday(submission.dueDate) && submission.status !== 'Axed' && submission.status !== 'Added in Bitrix' ? 'due-today' : ''}`}
                    onClick={() => toggleRow(submission.submissionId)}
                  >
                    {columnConfig.map(column => {
                      let value = submission[column.accessor]
                      
                      // Special handling for entry date
                      if (column.key === 'entryDate') {
                        if (value) {
                          try {
                            // Handle both Google Sheets (YYYY-MM-DD HH:MM:SS) and Supabase ISO (YYYY-MM-DDTHH:MM:SSZ) formats
                            const dateStr = value.trim();
                            // Extract just the date part - split on space for Google Sheets or 'T' for ISO format
                            const dateOnly = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr.split(' ')[0];
                            value = dateOnly;
                          } catch (error) {
                            console.error('Error parsing timestamp:', value, error);
                            value = 'Invalid Date';
                          }
                        } else {
                          value = 'N/A'
                        }
                      }
                      
                      // Special handling for status
                      if (column.key === 'status') {
                        return (
                          <td key={column.key}>
                            <span className={`status-badge ${submission.status?.toLowerCase().replace(/\s+/g, '-') || 'no-status'}`}>
                              {submission.status || 'N/A'}
                            </span>
                          </td>
                        )
                      }
                      
                      // Special handling for listingLink - show Open button
                      if (column.key === 'listingLink') {
                        return (
                          <td key={column.key}>
                            <a
                              href={submission.listingLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              Open
                            </a>
                          </td>
                        )
                      }
                      
                      // Default handling for other columns
                      return (
                        <td key={column.key} className={column.key === 'entryDate' ? 'submission-id' : ''}>
                          {value || 'N/A'}
                        </td>
                      )
                    })}
                    <td>
                      <button alt="Edit Entry" title="Edit Entry"
                        className="edit-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (!expandedRows.has(submission.submissionId)) {
                            toggleRow(submission.submissionId)
                          }
                          startEdit(submission)
                        }}
                      >
                        🖉
                      </button>
                    </td>
                  </tr>
                  
                  {expandedRows.has(submission.submissionId) && (
                    <tr className="collapsible-row">
                      <td colSpan="7">
                        <div className="collapsible-content">
                          {editingRow === submission.submissionId ? (
                            <div className="edit-form">
                              <div className="edit-form-grid">
                                <div className="edit-item">
                                  <label>CIM Received:</label>
                                  <div className="checkbox-toggle">
                                    <input
                                      type="checkbox"
                                      checked={editFormData.cimReceived === 'TRUE'}
                                      onChange={(e) => handleEditChange('cimReceived', e.target.checked ? 'TRUE' : 'FALSE')}
                                    />
                                  </div>
                                </div>
                                <div className="edit-item">
                                  <label>Status:</label>
                                  <select
                                    value={editFormData.status}
                                    onChange={(e) => handleEditChange('status', e.target.value)}
                                  >
                                    <option value="">Select Status</option>
                                    {statusOptions.map(option => (
                                      <option key={option} value={option}>{option}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="edit-item full-width">
                                  <label>Notes:</label>
                                  <textarea
                                    value={editFormData.notes}
                                    onChange={(e) => handleEditChange('notes', e.target.value)}
                                    rows="3"
                                  />
                                </div>
                                <div className="edit-item">
                                  <label>Due Date:</label>
                                  <input
                                    type="date"
                                    value={editFormData.dueDate}
                                    onChange={(e) => handleEditChange('dueDate', e.target.value)}
                                  />
                                </div>
                              </div>
                              <div className="edit-actions">
                                <button className="save-btn" onClick={saveEdit}>
                                  Save Changes
                                </button>
                                <button className="cancel-btn" onClick={cancelEdit}>
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="deal-details">
                            <div className="detail-item">
                              <span className="detail-label">Submission ID:</span>
                              <span className="detail-value">{submission.submissionId || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                              <span className="detail-label">Brokerage:</span>
                              <span className="detail-value">{submission.brokerage || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                              <span className="detail-label">Broker Name:</span>
                              <span className="detail-value">{submission.brokerName || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                              <span className="detail-label">Broker Email:</span>
                              <span className="detail-value">{submission.brokerEmail || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                              <span className="detail-label">CIM Received:</span>
                              <span className="detail-value">
                                {submission.cimReceived === 'TRUE' ? (
                                  <span className="checkbox checked">✓</span>
                                ) : submission.cimReceived === 'FALSE' ? (
                                  <span className="checkbox unchecked">✗</span>
                                ) : (
                                  <span className="checkbox unknown">?</span>
                                )}
                              </span>
                            </div>
                            <div className="detail-item">
                              <span className="detail-label">Status:</span>
                              <span className="detail-value">{submission.status || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                              <span className="detail-label">Due Date:</span>
                              <span className="detail-value">{submission.dueDate || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                              <span className="detail-label">Modified Date:</span>
                              <span className="detail-value">
                                {submission.modifiedDate ? 
                                  new Date(submission.modifiedDate).toLocaleString('en-CA', { 
                                    year: 'numeric', 
                                    month: '2-digit', 
                                    day: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit',
                                    hour12: false
                                  }).replace(',', '') : 'N/A'}
                              </span>
                            </div>                            
                            <div className="detail-item">
                              <span className="detail-label">Sourced By:</span>
                              <span className="detail-value">{submission.sourcerEmail || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                              <span className="detail-label">Notes:</span>
                              <span className="detail-value">{submission.notes || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                              <span className="detail-label">Listing Link:</span>
                              <span className="detail-value listing-link">
                                {submission.listingLink ? (
                                  <a 
                                    href={submission.listingLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={submission.listingLink}
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {submission.listingLink}
                                  </a>
                                ) : (
                                  'N/A'
                                )}
                              </span>
                            </div>
                          </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Filter dropdown containers rendered outside table */}
      {activeFilterDropdown && (
        <div 
          className="filter-dropdown-container"
          style={{
            position: 'fixed',
            top: `${dropdownPosition.top}px`,
            left: `${dropdownPosition.left}px`
          }}
        >
          <FilterDropdown columnKey={activeFilterDropdown} />
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="pagination">
          <button
            className="pagination-btn"
            onClick={() => onPageChange(1, filters)}
            disabled={pagination.page === 1}
            title="Go to first page"
          >
            <span className="btn-label-full">« First</span>
            <span className="btn-label-short">«</span>
          </button>
          <button
            className="pagination-btn"
            onClick={() => onPageChange(pagination.page - 1, filters)}
            disabled={pagination.page === 1}
            title="Previous page"
          >
            <span className="btn-label-full">Previous</span>
            <span className="btn-label-short">‹</span>
          </button>
          <div className="pagination-jump">
            <input
              type="number"
              min="1"
              max={pagination.totalPages}
              value={pagination.page}
              onChange={(e) => {
                const newPage = parseInt(e.target.value, 10);
                if (newPage >= 1 && newPage <= pagination.totalPages) {
                  onPageChange(newPage, filters);
                }
              }}
              className="pagination-input"
            />
            <span className="pagination-info">
              / {pagination.totalPages}
            </span>
          </div>
          <button
            className="pagination-btn"
            onClick={() => onPageChange(pagination.page + 1, filters)}
            disabled={pagination.page === pagination.totalPages}
            title="Next page"
          >
            <span className="btn-label-full">Next</span>
            <span className="btn-label-short">›</span>
          </button>
          <button
            className="pagination-btn"
            onClick={() => onPageChange(pagination.totalPages, filters)}
            disabled={pagination.page === pagination.totalPages}
            title="Go to last page"
          >
            <span className="btn-label-full">Last »</span>
            <span className="btn-label-short">»</span>
          </button>
          <span className="pagination-total">
            ({pagination.total} records)
          </span>
        </div>
      )}
    </div>
  )
}

export default Panel

import React, { useState, useEffect, useMemo } from "react";
import Select from "react-select";
import "./Form.css";

const Form = ({
  partners,
  userEmail,
  onSubmit,
  onTogglePanel,
  panelVisible,
}) => {
  const [partner, setPartner] = useState(null);
  const [listingName, setListingName] = useState("");
  const [listingLink, setListingLink] = useState("");
  const [brokerage, setBrokerage] = useState("");
  const [brokerName, setBrokerName] = useState("");
  const [brokerEmail, setBrokerEmail] = useState("");
  const [sourceType, setSourceType] = useState("New");
  const [notes, setNotes] = useState("");
  const [dealStatus, setDealStatus] = useState("Inquired");
  const [status, setStatus] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [favorites, setFavorites] = useState([]);

  // Favorites management functions
  const getFavoritesKey = () => `userFavorites_${userEmail}`;
  
  const getStoredFavorites = () => {
    try {
      const stored = localStorage.getItem(getFavoritesKey());
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      console.error('Error reading favorites from localStorage:', error);
      return [];
    }
  };
  
  const saveFavorites = (favoritesList) => {
    try {
      localStorage.setItem(getFavoritesKey(), JSON.stringify(favoritesList));
    } catch (error) {
      console.error('Error saving favorites to localStorage:', error);
    }
  };
  
  const toggleFavorite = (partnerName) => {
    const currentFavorites = getStoredFavorites();
    let newFavorites;
    
    if (currentFavorites.includes(partnerName)) {
      newFavorites = currentFavorites.filter(fav => fav !== partnerName);
    } else {
      newFavorites = [...currentFavorites, partnerName];
    }
    
    saveFavorites(newFavorites);
    setFavorites(newFavorites);
  };
  
  // Clean up favorites that no longer exist in partners list
  const cleanupFavorites = (currentFavorites, currentPartners) => {
    const validFavorites = currentFavorites.filter(fav => currentPartners.includes(fav));
    if (validFavorites.length !== currentFavorites.length) {
      saveFavorites(validFavorites);
    }
    return validFavorites;
  };
  
  // Load and clean favorites when partners change
  useEffect(() => {
    if (partners.length > 0 && userEmail) {
      const storedFavorites = getStoredFavorites();
      const cleanedFavorites = cleanupFavorites(storedFavorites, partners);
      setFavorites(cleanedFavorites);
    }
  }, [partners, userEmail]);
  
  // Create partner options with favorites first
  const partnerOptions = useMemo(() => {
    const favoriteOptions = favorites.map(fav => ({
      value: fav,
      label: (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{fav}</span>
          <span 
            onClick={(e) => {
              e.stopPropagation();
              toggleFavorite(fav);
            }}
            style={{ 
              cursor: 'pointer', 
              color: '#fbbf24',
              fontSize: '16px',
              marginLeft: '8px'
            }}
            title="Remove from favorites"
          >
            ⭐
          </span>
        </div>
      ),
      isFavorite: true
    }));
    
    const nonFavoriteOptions = partners
      .filter(p => !favorites.includes(p))
      .map(p => ({
        value: p,
        label: (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{p}</span>
            <span 
              onClick={(e) => {
                e.stopPropagation();
                toggleFavorite(p);
              }}
              style={{ 
                cursor: 'pointer', 
                color: '#d1d5db',
                fontSize: '16px',
                marginLeft: '8px'
              }}
              title="Add to favorites"
            >
              ☆
            </span>
          </div>
        ),
        isFavorite: false
      }));
    
    const options = [];
    
    if (favoriteOptions.length > 0) {
      options.push({
        value: 'favorites-separator',
        label: 'FAVORITES',
        isDisabled: true,
        isSeparator: true
      });
      options.push(...favoriteOptions);
    }
    
    if (nonFavoriteOptions.length > 0 && favoriteOptions.length > 0) {
      options.push({
        value: 'non-favorites-separator',
        label: 'ALL PARTNERS',
        isDisabled: true,
        isSeparator: true
      });
    }
    
    options.push(...nonFavoriteOptions);
    
    return options;
  }, [partners, favorites]);

  const handleSourceTypeChange = (e) => {
    setSourceType(e.target.value);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!window.confirm("Please validate if all fields are correct before submitting. Some fields cannot be changed after submission. \n\nAre you sure you want to submit?")) {
      return;
    }

    // Always validate listing name length regardless of source type
    if (listingName.length > 180) {
      alert("Listing Name must be 180 characters or less");
      return;
    }

    // Skip validation if sourceType is "Resourced"
    if (sourceType !== "Resourced") {
      const errors = {};
      if (!partner) errors.partner = true;
      if (!listingName.trim()) errors.listingName = true;
      if (!listingLink.trim()) errors.listingLink = true;
      if (!brokerEmail.trim()) errors.brokerEmail = true;
      if (!sourceType) errors.sourceType = true;
      if (!dealStatus) errors.dealStatus = true;

      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        alert("Please fill all required fields");
        return;
      }

      setFieldErrors({});
    }

    setIsSubmitting(true);
    setStatus("Submitting...");

    try {
      const result = await onSubmit({
        partner: partner.value.replace(/[❗⭐]/g, ''),
        listingName,
        listingLink,
        brokerage,
        brokerName,
        brokerEmail,
        sourceType,
        notes,
        status: dealStatus,
      });

      setStatus(`Saved ${result.id}`);

      // Reset form
      setPartner(null);
      setListingName("");
      setListingLink("");
      setBrokerage("");
      setBrokerName("");
      setBrokerEmail("");
      setSourceType("New");
      setNotes("");
      setDealStatus("Inquired");
    } catch (error) {
      alert(error.message || "Error saving data");
      setStatus("");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="card">
      <h2>Deal Sourcing Form</h2>

      <form onSubmit={handleSubmit}>
        <label className={fieldErrors.partner ? "error" : ""}>Client Name <span className="required-asterisk">*</span></label>
        <Select
          value={partner}
          onChange={(selectedOption) => {
            if (selectedOption && !selectedOption.isSeparator) {
              setPartner(selectedOption);
              if (fieldErrors.partner) {
                setFieldErrors(prev => ({ ...prev, partner: false }));
              }
            }
          }}
          options={partnerOptions}
          placeholder="-- Select Partner --"
          className="react-select-container"
          classNamePrefix="react-select"
          isDisabled={isSubmitting}
          styles={{
            control: (baseStyles, state) => ({
              ...baseStyles,
              borderColor: fieldErrors.partner ? '#dc2626' : baseStyles.borderColor,
              boxShadow: fieldErrors.partner ? '0 0 0 2px rgba(220, 38, 38, 0.25)' : baseStyles.boxShadow,
              '&:hover': {
                borderColor: fieldErrors.partner ? '#dc2626' : baseStyles['&:hover']?.borderColor,
              },
            }),
            option: (baseStyles, state) => {
              const isSeparator = state.data.isSeparator;
              return {
                ...baseStyles,
                backgroundColor: isSeparator ? '#f3f4f6' : (state.isFocused ? '#e5e7eb' : baseStyles.backgroundColor),
                color: isSeparator ? '#6b7280' : baseStyles.color,
                fontWeight: isSeparator ? 'bold' : baseStyles.fontWeight,
                cursor: isSeparator ? 'default' : 'pointer',
                fontSize: isSeparator ? '12px' : baseStyles.fontSize,
                padding: isSeparator ? '8px 12px' : baseStyles.padding,
              };
            },
          }}
          components={{
            Option: ({ children, ...props }) => {
              if (props.data.isSeparator) {
                return (
                  <div 
                    style={{ 
                      padding: '8px 12px', 
                      background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', 
                      color: '#ffffff', 
                      fontWeight: 'bold',
                      fontSize: '15px',
                      borderBottom: '1px solid #1e3a8a'
                    }}
                  >
                    {props.data.label}
                  </div>
                );
              }
              return (
                <div 
                  {...props.innerProps}
                  style={{
                    ...props.innerProps.style,
                    padding: '8px 12px',
                    cursor: 'pointer'
                  }}
                >
                  {children}
                </div>
              );
            },
          }}
        />

        <label className={fieldErrors.listingName ? "error" : ""}>Listing Name <span className="required-asterisk">*</span></label>
        <input
          type="text"
          value={listingName}
          onChange={(e) => {
            setListingName(e.target.value);
            if (fieldErrors.listingName) {
              setFieldErrors(prev => ({ ...prev, listingName: false }));
            }
          }}
          disabled={isSubmitting}
          className={fieldErrors.listingName ? "error" : ""}
          maxLength={180}
        />
        <div className={`character-count ${listingName.length === 180 ? "limit-reached" : ""}`}>({listingName.length}/180)</div>

        <label className={fieldErrors.listingLink ? "error" : ""}>Listing Link <span className="required-asterisk">*</span></label>
        <input
          type="text"
          value={listingLink}
          onChange={(e) => {
            setListingLink(e.target.value);
            if (fieldErrors.listingLink) {
              setFieldErrors(prev => ({ ...prev, listingLink: false }));
            }
          }}
          disabled={isSubmitting}
          className={fieldErrors.listingLink ? "error" : ""}
        />

        <label>Brokerage</label>
        <input
          type="text"
          value={brokerage}
          onChange={(e) => setBrokerage(e.target.value)}
          disabled={isSubmitting}
        />

        <label>Broker Name</label>
        <input
          type="text"
          value={brokerName}
          onChange={(e) => setBrokerName(e.target.value)}
          disabled={isSubmitting}
        />

        <label className={fieldErrors.brokerEmail ? "error" : ""}>Broker Email <span className="required-asterisk">*</span></label>
        <input
          type="text"
          value={brokerEmail}
          onChange={(e) => {
            setBrokerEmail(e.target.value);
            if (fieldErrors.brokerEmail) {
              setFieldErrors(prev => ({ ...prev, brokerEmail: false }));
            }
          }}
          disabled={isSubmitting}
          className={fieldErrors.brokerEmail ? "error" : ""}
        />

        <label className={fieldErrors.sourceType ? "error" : ""}>Source Type <span className="required-asterisk">*</span></label>
        <select
          value={sourceType}
          onChange={(e) => {
            handleSourceTypeChange(e);
            if (fieldErrors.sourceType) {
              setFieldErrors(prev => ({ ...prev, sourceType: false }));
            }
          }}
          disabled={isSubmitting}
          className={fieldErrors.sourceType ? "error" : ""}
        >
          <option value="" disabled>
            -- Select Source Type --
          </option>
          <option value="Resourced">Resourced</option>
          <option value="New">New</option>
        </select>

        <label className={fieldErrors.dealStatus ? "error" : ""}>Status <span className="required-asterisk">*</span></label>
        <select
          value={dealStatus}
          onChange={(e) => {
            setDealStatus(e.target.value);
            if (fieldErrors.dealStatus) {
              setFieldErrors(prev => ({ ...prev, dealStatus: false }));
            }
          }}
          disabled={isSubmitting}
          className={fieldErrors.dealStatus ? "error" : ""}
        >
          <option value="" disabled>
            -- Select Status --
          </option>
          <option value="Inquired">Inquired</option>
          <option value="Pending NDA">Pending NDA</option>
          <option value="NDA Signed">NDA Signed</option>
          <option value="Follow up">Follow up</option>
          <option value="For Broker Intro Call">For Broker Intro Call</option>
          <option value="Added in Bitrix">Added in Bitrix</option>
          <option value="Axed">Axed</option>
        </select>

        <label>Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={isSubmitting}
        />

        <label>User Email</label>
        <input className="readonly-input" type="text" value={userEmail} readOnly />

        <div className="button-row">
          <button type="submit" className="submit-btn" disabled={isSubmitting}>
            {isSubmitting ? "Submitting..." : "Submit"}
          </button>
          <button type="button" className="glass-btn" onClick={onTogglePanel}>
            {panelVisible ? "Hide Sourced Deals" : "Show Sourced Deals"}
          </button>
        </div>

        {status && (
          <div className="status">
            <span>{status}</span>
          </div>
        )}
      </form>
    </div>
  );
};

export default Form;

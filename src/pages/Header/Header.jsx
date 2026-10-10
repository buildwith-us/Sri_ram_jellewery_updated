import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import useAuthContext from '../../hooks/useAuthContext';
import useCart from '../../hooks/useCart';
import RightSideDrawer from '../../components/RightSideDrawer/RightSideDrawer';
import useAxiosSecure from '../../hooks/useAxiosSecure';
import { useRegisterDialog } from '../../utils/dialogRegistry';

const Header = () => {
  const location = useLocation();
  const { user, isAuthLoading } = useAuthContext();
  const { cartData, cartSubtotal, refetch: refetchCart } = useCart();
  const [axiosSecure] = useAxiosSecure();
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Registered so overlays that must step aside (the floating WhatsApp
  // button, the timed sign-in prompt) know the menu is covering the page.
  useRegisterDialog('mobile-menu', mobileMenuOpen);
  const [showCartDrawer, setShowCartDrawer] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  const isHome = location.pathname === '/';

  // Scroll listener for header shrink/shadow
  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 80);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location]);

  const isActive = (path) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const handleRemoveFromCart = (productId) => {
    axiosSecure.delete(`/cart/${productId}`).then(() => {
      refetchCart();
    });
  };

  const navLinks = [
    { path: '/', label: 'Home' },
    { path: '/shop', label: 'Shop' },
    { path: '/categories', label: 'Categories' },
    { path: '/about', label: 'About' },
    { path: '/contact', label: 'Contact' },
  ];

  const cartCount = cartData?.length || 0;

  // Minimum accessible touch target: 44x44 CSS px, icon centred inside.
  const touchTarget = "relative flex items-center justify-center w-11 h-11 shrink-0";

  return (
    <>
      <header
        className={`fixed z-50 w-full transition-ui duration-500 ease-in-out border-b top-0 ${scrolled || !isHome ? 'bg-surface shadow-sm py-2 border-primary/5' : 'bg-transparent py-4 border-white/10'}`}
        id="main-nav"
      >
        <div className="flex justify-between items-center w-full px-margin-mobile md:px-margin-desktop py-4 max-w-container-max mx-auto gap-4">
          
          {/* Logo & Brand (Left) */}
          <div className="shrink-0">
            <Link className="flex items-center gap-2 sm:gap-4 group min-w-0" to="/">
              <img
                alt="Sri Ram Jewellery Logo"
                className="h-9 sm:h-14 w-auto object-contain shrink-0 transition-transform duration-500 group-hover:scale-105"
                // Self-hosted. This was a lh3.googleusercontent.com/aida-public URL —
                // a temporary design-tool asset that expires, which would have
                // silently emptied the header on every page.
                src="/logo.png"
              />
              <span className={`hidden min-[360px]:inline-block whitespace-nowrap font-display-lg text-[15px] sm:text-body-lg lg:text-headline-sm tracking-tight ${isHome && !scrolled ? 'text-white' : 'text-primary'}`}>
                Sri Ram Jewellery
              </span>
            </Link>
          </div>

          {/* Navigation Links (Centered) */}
          <nav className="hidden lg:flex items-center gap-10">
            {navLinks.map((link) => {
              const linkClasses = `
                  ${isActive(link.path) && link.label !== 'Categories'
                    ? (isHome && !scrolled ? 'text-white border-b-2 border-white pb-1' : 'text-on-surface border-b-2 border-primary pb-1')
                    : (isHome && !scrolled ? 'text-white/80 hover:text-white transition-colors' : 'text-on-surface-variant hover:text-primary transition-colors')
                  } font-button-text text-button-text uppercase tracking-[0.2em]
                `;
                
              if (link.path.includes('#')) {
                return (
                  <a key={link.label} href={link.path} className={linkClasses}>
                    {link.label}
                  </a>
                );
              }
              
              return (
                <Link
                  key={link.label}
                  className={linkClasses}
                  to={link.path}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>

          {/* Search & Icons (Right) */}
          <div className="flex items-center gap-6 shrink-0">
            <div className="flex items-center gap-8">
              <div className="hidden lg:block relative group">
                <div className={`w-64 flex items-center border rounded-full px-5 py-2 gap-3 ${isHome && !scrolled ? 'bg-white/10 backdrop-blur-md border-white/20' : 'bg-surface-container-low border-primary/10'}`}>
                  <span className={`material-symbols-outlined text-[20px] ${isHome && !scrolled ? 'text-white/70' : 'text-on-surface-variant'}`}>search</span>
                  <input 
                    className={`bg-transparent border-none focus:ring-0 p-0 w-full text-body-base text-sm outline-none ${isHome && !scrolled ? 'text-white placeholder:text-white/40' : 'text-on-surface placeholder:text-on-surface-variant/40'}`} 
                    placeholder="Search jewellery..." 
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              </div>
              
              {/* Each control is a >=44px touch target (WCAG 2.5.5 / Apple HIG);
                  the icon stays 24px and is centred inside it. */}
              <div className="flex items-center gap-0.5 sm:gap-3">
                <Link
                  className={`${touchTarget} ${isHome && !scrolled ? 'text-white hover:scale-110' : 'text-on-surface hover:text-primary'} transition-ui`}
                  to="/wishlist"
                  aria-label="Wishlist"
                >
                  <span className="material-symbols-outlined font-light">favorite</span>
                </Link>

                <button
                  className={`${touchTarget} ${isHome && !scrolled ? 'text-white hover:scale-110' : 'text-on-surface hover:text-primary'} transition-ui`}
                  onClick={() => setShowCartDrawer(true)}
                  aria-label={`Cart${cartCount > 0 ? ` (${cartCount} items)` : ''}`}
                >
                  <span className="material-symbols-outlined font-light">shopping_bag</span>
                  {cartCount > 0 && (
                    <span className={`absolute top-1.5 right-1.5 text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center ${isHome && !scrolled ? 'bg-white text-primary' : 'bg-primary text-white'}`}>
                      {cartCount}
                    </span>
                  )}
                </button>

                <Link
                  className={`${touchTarget} ${isHome && !scrolled ? 'text-white hover:scale-110' : 'text-on-surface hover:text-primary'} transition-ui`}
                  to={user ? "/dashboard" : "/login"}
                  aria-label={user ? "My account" : "Sign in"}
                >
                  <span className="material-symbols-outlined font-light">person</span>
                </Link>

                {/* Mobile menu toggle */}
                <button
                  className={`lg:hidden ${touchTarget} ${isHome && !scrolled ? 'text-white' : 'text-on-surface hover:text-primary'} transition-colors`}
                  onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                  aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
                  aria-expanded={mobileMenuOpen}
                >
                  <span className="material-symbols-outlined">{mobileMenuOpen ? 'close' : 'menu'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Mobile Navigation Dropdown */}
        {mobileMenuOpen && (
          <div className="lg:hidden absolute top-full left-0 w-full bg-surface border-b border-primary/10 shadow-lg">
            <div className="flex flex-col px-margin-mobile py-4 space-y-4">
              <div className="flex items-center bg-surface-container-low border border-primary/10 rounded-full px-5 py-2 gap-3 mb-2">
                <span className="material-symbols-outlined text-on-surface-variant text-[20px]">search</span>
                <input 
                  className="bg-transparent border-none focus:ring-0 p-0 w-full text-body-base text-on-surface text-sm placeholder:text-on-surface-variant/40 outline-none" 
                  placeholder="Search jewellery..." 
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              {navLinks.map((link) => {
                const linkClasses = `
                    ${isActive(link.path) && link.label !== 'Categories'
                      ? 'text-primary'
                      : 'text-on-surface-variant'
                    } font-button-text text-button-text uppercase tracking-[0.2em] flex items-center min-h-11
                  `;
                  
                if (link.path.includes('#')) {
                  return (
                    <a key={link.label} href={link.path} className={linkClasses}>
                      {link.label}
                    </a>
                  );
                }
                
                return (
                  <Link
                    key={link.label}
                    className={linkClasses}
                    to={link.path}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </header>

      {/* Cart Right Side Drawer */}
      <RightSideDrawer 
        showRightDrawer={showCartDrawer} 
        setShowRightDrawer={setShowCartDrawer} 
        cartData={cartData} 
        removeFromCart={handleRemoveFromCart} 
        cartSubtotal={cartSubtotal}
      />
    </>
  );
};

export default Header;

import { Link } from "react-router-dom";
import { Logo } from "./shared";
import { managedSite } from "./site";
import "./footer.css";

export function PolicyLinks() {
  return (
    <nav className="policy-links" aria-label="Service information">
      <Link to="/privacy">Privacy</Link>
      <Link to="/terms">Terms</Link>
      <Link to="/security">Security</Link>
      <Link to="/support">Support</Link>
      <Link to="/legal">Legal</Link>
    </nav>
  );
}

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-brand">
        <Logo />
        <p>Memory for models that act.</p>
        <small>Operated by IntelliNxT, Australia.</small>
      </div>
      <nav aria-label="Product resources">
        <h2>Build</h2>
        <Link to={managedSite ? "/signup" : "/documentation/ISOLATED"}>
          {managedSite ? "Create an account" : "Get started"}
        </Link>
        <Link to="/documentation/HOSTED">Managed docs</Link>
        <Link to="/documentation/ISOLATED">Community docs</Link>
        <a href="https://github.com/enablewmodels-sys/chronograph">GitHub</a>
        <Link to="/documentation/LICENSING">Software licence</Link>
      </nav>
      <nav aria-label="Trust and support">
        <h2>Trust</h2>
        <Link to="/security">Security</Link>
        <Link to="/data-protection">Data protection</Link>
        <Link to="/subprocessors">Subprocessors</Link>
        <Link to="/status">Service status</Link>
        <Link to="/support">Support</Link>
      </nav>
      <nav aria-label="Legal policies">
        <h2>Legal</h2>
        <Link to="/privacy">Privacy policy</Link>
        <Link to="/terms">Terms of service</Link>
        <Link to="/cookies">Cookies</Link>
        <Link to="/acceptable-use">Acceptable use</Link>
        <Link to="/legal">Company information</Link>
      </nav>
      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} IntelliNxT</span>
        <span>ChronoDB Managed · Community available to self-host</span>
      </div>
    </footer>
  );
}

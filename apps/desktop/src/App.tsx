type IconName = "folder" | "file" | "book" | "check" | "settings" | "folder-open";

const iconPaths: Record<IconName, string> = {
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z",
  "folder-open": "M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v.8l-1.5 6.2a1.5 1.5 0 0 1-1.45 1.15H4.5A1.5 1.5 0 0 1 3 16.15z",
  file: "M6 3.5h8l4 4v13H6zM14 3.5v4h4M9 12h6M9 15.5h6",
  book: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 5.5v15M8 7h8M8 10.5h8",
  check: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17Zm-3.5 8.7 2.3 2.3 4.8-5",
  settings: "M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 0 0 0-7Zm0-5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18.01 5.99l-1.42 1.42M7.41 16.59l-1.42 1.42M18.01 18.01l-1.42-1.42M7.41 7.41 5.99 5.99",
};

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d={iconPaths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
    </svg>
  );
}

const navigation = [
  { label: "Workspace", icon: "folder" as const, selected: true },
  { label: "Translations", icon: "file" as const, selected: false },
  { label: "Glossary", icon: "book" as const, selected: false },
  { label: "Quality", icon: "check" as const, selected: false },
  { label: "Settings", icon: "settings" as const, selected: false },
];

function App() {
  return (
    <main className="shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <div>
            <p className="brand-name">Tsumugi</p>
            <p className="brand-description">Localization Workbench</p>
          </div>
        </div>

        <nav className="navigation" aria-label="Workbench sections">
          {navigation.map((item) => (
            <button
              aria-current={item.selected ? "page" : undefined}
              className={`navigation-item${item.selected ? " is-selected" : ""}`}
              disabled={!item.selected}
              key={item.label}
              title={item.selected ? undefined : `${item.label} will be available in a later module`}
              type="button"
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className="status-dot" aria-hidden="true" />
          <span>Ready</span>
        </div>
      </aside>

      <section className="workspace" aria-label="Workspace">
        <header className="topbar">
          <nav className="menu-bar" aria-label="Application menu">
            <button type="button" disabled>File</button>
            <button type="button" disabled>Edit</button>
            <button type="button" disabled>View</button>
            <button type="button" disabled>Help</button>
          </nav>
          <button className="settings-link" type="button" disabled title="Settings will be available in a later module">
            <Icon name="settings" size={18} />
            <span>Settings</span>
          </button>
        </header>

        <div className="workspace-body">
          <section className="empty-state" aria-live="polite">
            <div className="empty-state-icon" aria-hidden="true">
              <Icon name="folder-open" size={54} />
            </div>
            <h1>No project open</h1>
            <p>Open a localization project to get started.</p>
            <p>Translations, terminology, and quality tools will appear here.</p>
          </section>
        </div>
      </section>
    </main>
  );
}

export default App;

import React, { useEffect, useState } from "react";
import {
  ArrowRight, Check, ChevronLeft, ChevronRight, ShieldCheck,
  Users, Ticket, BarChart3, Settings, Activity, LogOut, Plus
} from "lucide-react";

const servers = [
  { id: "1", name: "My Community", members: "1,284", installed: true },
  { id: "2", name: "Creator Hub", members: "642", installed: false },
  { id: "3", name: "Gaming Lounge", members: "3,901", installed: true },
];

export default function App() {
  const [screen, setScreen] = useState("landing");
  const [session, setSession] = useState(null);
  const [selectedServer, setSelectedServer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [installingId, setInstallingId] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shouldRestoreSession = params.get("authenticated") === "1" || params.get("view") === "servers";

    if (!shouldRestoreSession) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    fetch("/api/session", { credentials: "include", cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        if (data.authenticated) {
          setSession(data);
          setScreen("servers");
        } else {
          setScreen("landing");
        }
      })
      .catch((error) => {
        console.error("Could not restore Discord session:", error);
        if (!cancelled) setScreen("landing");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          // Remove callback flags so refreshing does not repeat session restoration.
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      });

    return () => { cancelled = true; };
  }, []);

  async function installBot(server) {
    try {
      setInstallingId(server.id);

      const response = await fetch(
     `/api/guilds/${server.id}/invite`,
      {
       credentials: "include",
      }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Failed to create invite."
        );
      }

      window.open(
        data.url,
        "_blank",
        "noopener,noreferrer"
      );

      // Wait for Discord to actually add FallenAngel.
      for (let i = 0; i < 60; i++) {
        await new Promise((resolve) =>
          setTimeout(resolve, 2000)
        );

        const statusResponse = await fetch(
        `/api/guilds/${server.id}/status`,
        {
          credentials: "include",
        }
        );

        const status =
          await statusResponse.json();

        if (status.installed) {
          const updatedServer = {
            ...server,
            installed: true,
          };

          setSelectedServer(updatedServer);
          setInstallingId(null);
          setScreen("dashboard");

          return;
        }
      }

      setInstallingId(null);
    } catch (error) {
      console.error(error);
      setInstallingId(null);
    }
  }

  function selectServer(server) {
    setSelectedServer(server);
    setScreen("dashboard");
  }

  function logout() {
    window.location.href = "/auth/logout";
  }

  if (loading || screen === "loading") {
    return (
      <div className="loading-screen">
        <div className="loading-logo">
          FALLENANGEL
        </div>

        <div className="loading-line" />
      </div>
    );
  }

  if (screen === "landing") {
    return (
      <Landing
      onAddToDiscord={() => {
        window.location.href = "/auth/install?return_to=home";
      }}
       onDashboard={async () => {
        try {
         const response = await fetch("/api/session", {
          credentials: "include",
          cache: "no-store",
         });

         const data = await response.json();

          if (data.authenticated) {
            setSession(data);
           setScreen("servers");
          } else {
             window.location.href = "/auth/discord";
            }
        } catch (error) {
           console.error("Session check failed:", error);
           window.location.href = "/auth/discord";
          }
       }}
     />
    );
  }

  if (screen === "verify") {
    return (
      <Verify
        onBack={() => setScreen("landing")}
      />
    );
  }

  if (screen === "servers") {
    return (
      <ServerSelect
        user={session?.user}
        servers={(session?.guilds || []).filter(
         (server) => server.installed
        )}
        installingId={installingId}
        onBack={() =>
          setScreen("landing")
        }
        onSelect={selectServer}
        onInstall={installBot}
        onLogout={logout}
      />
    );
  }

  if (screen === "dashboard") {
    return (
      <Dashboard
        server={selectedServer}
        onLogout={logout}
      />
    );
  }

  return null;
}


function Landing({ onDashboard, onAddToDiscord }) {
  const [introKey, setIntroKey] = React.useState(0);
  const [navVisible, setNavVisible] = useState(true);
  const [navAtTop, setNavAtTop] = useState(true);

  useEffect(() => {
    let previousY = window.scrollY;

    const handleScroll = () => {
    const currentY = window.scrollY;

    setNavAtTop(currentY < 10);

    if (currentY < 10) {
      setNavVisible(true);
    } else if (currentY < previousY) {
      setNavVisible(true);
    } else if (currentY > previousY) {
      setNavVisible(false);
    }

    previousY = currentY;
  };

  window.addEventListener("scroll", handleScroll, {
    passive: true,
  });

  return () => {
    window.removeEventListener("scroll", handleScroll);
  };
  }, []);

  React.useEffect(() => {
    setIntroKey((key) => key + 1);
  }, []);

  return (
    <main className="fa-home" key={introKey}>
      {/* Full-screen animated raven introduction */}
      <div className="fa-intro" aria-hidden="true">
        <img
          className="fa-intro-gif"
          src="/assets/raven-flight.gif"
          alt=""
        />
        <div className="fa-intro-shade" />
      </div>

      {/* Permanent atmospheric background */}
      <div className="fa-home-atmosphere" aria-hidden="true" />

      {/* Navigation */}
      <header
        className={[
         "fa-nav",
          navVisible ? "fa-nav-visible" : "fa-nav-hidden",
          navAtTop ? "fa-nav-top" : "fa-nav-scrolled",
        ].join(" ")}
        >
       <a className="fa-brand" href="/" aria-label="FallenAngel home">
         <img
           src="/assets/fallenangel-wings.png"
           alt=""
          className="fa-brand-icon"
          />
         <span>FALLENANGEL</span>
       </a>

        <button className="fa-nav-dashboard" onClick={onDashboard}>
          Dashboard <span aria-hidden="true">↗</span>
        </button>
      </header>

      {/* Main cinematic entrance */}
      <section className="fa-hero">
        <div className="fa-wings-wrap" aria-hidden="true">
          <img
            className="fa-hero-wings"
            src="/assets/fallenangel-wings.png"
            alt=""
          />
        </div>

        <div className="fa-hero-content">
          <p className="fa-kicker">
            YOUR COMMUNITY. YOUR RULES.
          </p>

          <h1>
            Control the
            <br />
            <span>chaos.</span>
          </h1>

          <p className="fa-hero-description">
            One place to shape your server.
            <br />
            Built for the communities that matter.
          </p>

         <button className="fa-hero-button" onClick={onAddToDiscord}>
          Add to Discord
          <span aria-hidden="true">→</span>
        </button>
        </div>
      </section>

      <footer className="fa-home-footer">
        <span>FALLENANGEL · DISCORD MANAGEMENT</span>
        <span className="fa-status">
          <span />
          SYSTEM ONLINE
        </span>
      </footer>
    </main>
  );
}


function Verify({ onBack }) {
  async function continueWithDiscord() {
    try {
      const response = await fetch("/api/session", {
        credentials: "include",
        cache: "no-store",
      });

      const data = await response.json();

      if (data.authenticated) {
        window.location.href = "/";
        return;
      }

      window.location.href = "/auth/discord";
    } catch (error) {
      console.error("Session check failed:", error);
      window.location.href = "/auth/discord";
    }
  }

  return (
    <main className="auth-page">
      <button className="auth-back" onClick={onBack}>
        ← Back
      </button>

      <div className="auth-card">
        <div className="auth-icon">🪽</div>

        <p className="eyebrow">FALLENANGEL</p>

        <h1>Connect your Discord</h1>

        <p>
          Authorize FallenAngel to access the
          servers you manage.
        </p>

        <button
          className="discord-button"
          onClick={continueWithDiscord}
        >
          <svg
            className="discord-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              d="M19.54 5.16A16.9 16.9 0 0 0 15.35 4l-.51 1.04a15.3 15.3 0 0 0-5.68 0L8.65 4a16.9 16.9 0 0 0-4.19 1.16C1.8 9.43 1.08 13.58 1.44 17.67a16.9 16.9 0 0 0 5.15 2.59l1.25-1.71c-.69-.26-1.34-.59-1.95-.98l.48-.37c3.76 1.76 7.84 1.76 11.55 0l.48.37c-.61.39-1.26.72-1.95.98l1.25 1.71a16.9 16.9 0 0 0 5.15-2.59c.42-4.78-.72-8.89-3.31-12.51ZM8.46 15.21c-1.1 0-2-.99-2-2.21s.88-2.21 2-2.21 2 .99 2 2.21-.89 2.21-2 2.21Zm7.08 0c-1.1 0-2-.99-2-2.21s.88-2.21 2-2.21 2 .99 2 2.21-.89 2.21-2 2.21Z"
            />
          </svg>

          <span>Continue with Discord</span>
        </button>

        <div className="auth-note">
          We only request the access required to
          show your manageable servers.
        </div>
      </div>
    </main>
  );
}

function ServerSelect({
  user,
  servers,
  installingId,
  onBack,
  onSelect,
  onInstall,
  onLogout,
}) {
  return (
    <main className="server-page">
      <div className="server-header">
       <button
         className="auth-back"
         onClick={onBack}
        >
          ← Back
        </button>

        <div style={{ display: "flex", gap: "10px" }}>
        <button
          className="server-action add"
          onClick={() => {
          window.location.href ="/auth/install?return_to=dashboard";
         }}
        >
         <span className="add-symbol">+</span>
          <span>Add another server</span>
        </button>

          <button
            className="logout-button"
           onClick={onLogout}
           >
            Log out
          </button>
        </div>
      </div>

      <section className="server-selector">
        <div className="server-selector-heading">
          <p className="eyebrow">
            FALLENANGEL
          </p>

          <h1>
            Select a server
          </h1>

          <p>
            Choose a Discord server you want to
            manage with FallenAngel.
          </p>
        </div>

        <div className="discord-user">
          <div className="discord-user-avatar">
            {user?.avatar ? (
              <img
                src={`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`}
                alt=""
              />
            ) : (
              user?.username
                ?.charAt(0)
                ?.toUpperCase()
            )}
          </div>

          <div>
            <strong>
              {user?.global_name ||
                user?.username}
            </strong>

            <span>
              Discord account
            </span>
          </div>
        </div>

        <div className="server-list">
          {servers.length === 0 ? (
            <div className="empty-servers">
           <h3>No servers connected yet</h3>
          <p>
             Add FallenAngel to a Discord server you
             manage to start using your dashboard.
          </p>
         <button
             className="server-action add"
             onClick={() => {
             window.location.href = "/auth/install";
            }}
            >
            <span className="add-symbol">+</span>
            <span>Add to Discord</span>
          </button>
         </div>
            ) : (
            servers.map((server) => {
              const installing =
                installingId === server.id;

              return (
                <div
                  className="server-row"
                  key={server.id}
                >
                  <div className="server-identity">
                    <div className="server-avatar">
                      {server.icon ? (
                        <img
                          src={`https://cdn.discordapp.com/icons/${server.id}/${server.icon}.png?size=128`}
                          alt=""
                        />
                      ) : (
                        server.name
                          .charAt(0)
                          .toUpperCase()
                      )}
                    </div>

                    <div className="server-info">
                      <strong>
                        {server.name}
                      </strong>

                      <span>
                        {server.installed
                          ? "FallenAngel is installed"
                          : "FallenAngel isn't installed"}
                      </span>
                    </div>
                  </div>

                  {server.installed ? (
                    <button
                      className="server-action installed"
                      onClick={() =>
                        onSelect(server)
                      }
                    >
                      <span>
                        Manage
                      </span>

                      <span className="server-arrow">
                        →
                      </span>
                    </button>
                  ) : (
                    <button
                      className="server-action add"
                      disabled={installing}
                      onClick={() =>
                        onInstall(server)
                      }
                    >
                      {installing ? (
                        <>
                          <span className="spinner" />
                          <span>
                            Waiting...
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="add-symbol">
                            +
                          </span>

                          <span>
                            Add FallenAngel
                          </span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        <p className="server-footer">
          FallenAngel only displays servers you
          have permission to manage.
        </p>
      </section>
    </main>
  );
}

function Dashboard({ server, onLogout }) {
  const [tab, setTab] = useState("overview");
  const [protection, setProtection] = useState({ spam: true, mentions: true, raids: false, links: true });
  const nav = [
    ["overview", "Overview", Activity],
    ["protection", "Protection", ShieldCheck],
    ["community", "Community", Users],
    ["support", "Support", Ticket],
    ["engagement", "Engagement", BarChart3],
  ];
  return (
    <div className="dashboard-shell">
      <aside className="dash-sidebar">
        <div className="dash-brand"><span>F</span><div><b>FALLENANGEL</b><small>DASHBOARD</small></div></div>
        <div className="selected-server"><div className="server-avatar small">{server?.name?.slice(0,1)}</div><div><small>SERVER</small><strong>{server?.name}</strong></div><ChevronRight size={15}/></div>
        <div className="nav-title">MANAGE</div>
        <nav>{nav.map(([id, label, Icon]) => <button key={id} className={tab === id ? "nav-active" : ""} onClick={() => setTab(id)}><Icon size={17}/>{label}</button>)}</nav>
        <div className="dash-bottom">
          <button><Settings size={17}/> Settings</button>
          <button className="logout" onClick={onLogout}><LogOut size={17}/> Sign out</button>
        </div>
      </aside>
      <main className="dash-main">
        <header className="dash-header"><span>FALLENANGEL / {nav.find(x => x[0] === tab)?.[1].toUpperCase()}</span><div><span className="online-dot" /> FallenAngel Online</div></header>
        {tab === "overview" && <Overview server={server} setTab={setTab} />}
        {tab === "protection" && <Protection settings={protection} setSettings={setProtection} />}
        {tab === "community" && <Module title="Community" icon={Users} text="Create a better first impression for every member who joins." />}
        {tab === "support" && <Module title="Support" icon={Ticket} text="Give members a clear path to reach your team." />}
        {tab === "engagement" && <Module title="Engagement" icon={BarChart3} text="Give your community reasons to participate and return." />}
      </main>
    </div>
  );
}

function Overview({ server, setTab }) {
  return <div className="dash-content">
    <div className="dash-hero">
      <div><div className="eyebrow">WELCOME BACK</div><h2>{server?.name}<br/><em>is under control.</em></h2><p>Everything important, in one place. Configure FallenAngel around the way your community actually works.</p></div>
      <div className="live-card"><span className="live-ring" /><div><b>All systems operational</b><small>Bot connected to Discord</small></div></div>
    </div>
    <div className="metrics"><Metric label="Members" value={server?.members || "—"} /><Metric label="Protection" value="Active" /><Metric label="Uptime" value="99.98%" /></div>
    <div className="control-head"><div className="eyebrow">CONTROL CENTER</div><h3>What do you want to manage?</h3></div>
    <div className="module-grid">
      <ModuleCard icon={ShieldCheck} title="Protection" text="Keep your community safe." onClick={() => setTab("protection")} />
      <ModuleCard icon={Users} title="Community" text="Welcome members properly." onClick={() => setTab("community")} />
      <ModuleCard icon={Ticket} title="Support" text="Make help easy to reach." onClick={() => setTab("support")} />
      <ModuleCard icon={BarChart3} title="Engagement" text="Give people a reason to return." onClick={() => setTab("engagement")} />
    </div>
  </div>;
}

function Protection({ settings, setSettings }) {
  const items = [
    ["spam", "Spam protection", "Detect repeated messages and disruptive posting patterns."],
    ["mentions", "Mention protection", "Limit excessive mentions that disrupt your community."],
    ["raids", "Raid protection", "React to sudden waves of new members and suspicious activity."],
    ["links", "Link protection", "Control unwanted or suspicious external links."],
  ];
  return <div className="dash-content narrow">
    <div className="module-title"><div className="eyebrow">PROTECTION</div><h2>Keep your community <em>protected.</em></h2><p>FallenAngel watches for disruptive behavior so your moderators can focus on the community.</p></div>
    <div className="protection-bar"><span><ShieldCheck size={18}/> Protection active</span><small><Check size={13}/> Changes save automatically</small></div>
    <div className="settings-list">{items.map(([key,title,text]) => <div className="setting" key={key}><div><b>{title}</b><p>{text}</p></div><button className={`toggle ${settings[key] ? "on" : ""}`} onClick={() => setSettings(s => ({...s,[key]:!s[key]}))}><i/></button></div>)}</div>
  </div>;
}

function Metric({label,value}) { return <div className="metric"><small>{label}</small><b>{value}</b><span>Healthy</span></div>; }
function ModuleCard({icon:Icon,title,text,onClick}) { return <button className="module-card" onClick={onClick}><span><Icon size={20}/></span><div><b>{title}</b><p>{text}</p></div><ArrowRight size={16}/></button>; }
function Module({title,icon:Icon,text}) { return <div className="dash-content empty-module"><span className="big-icon"><Icon size={28}/></span><div className="eyebrow">FALLENANGEL</div><h2>{title}</h2><p>{text}</p><button className="blue-button"><Plus size={16}/> Configure {title}</button></div>; }

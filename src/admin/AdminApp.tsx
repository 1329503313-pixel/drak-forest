import { useCallback, useEffect, useState } from "react";
import { MATCH_MODE_OPTIONS, type MatchMode } from "@/constants/matchModes";
import type { LeaderboardByMode, MatchHistoryItem } from "@/types/match";
import {
  adminFetch,
  clearAdminToken,
  fetchAdminStatus,
  loadAdminToken,
  loginAdmin,
  logoutAdmin,
  saveAdminToken,
} from "@/utils/adminApi";
import { DEFAULT_AVATAR } from "@/utils/defaultAvatar";
import { AdminReplayModal } from "@/admin/AdminReplayModal";
import { AdminSpectateOverlay } from "@/admin/AdminSpectateOverlay";
import "./admin.css";

type Tab = "overview" | "users" | "rooms" | "games" | "matches" | "leaderboard" | "adminAccounts";

type Overview = {
  roomCount: number;
  activeGameCount: number;
  accountCount: number;
  finishedMatchCount: number;
};

type AccountRow = {
  gameAccountId: string;
  nickname: string;
  avatar: string;
  updatedAt: number;
};

type AdminRoomPayload = {
  code: string;
  hostId: string;
  matchModeLabel: string;
  gameInProgress?: boolean;
  players: Array<{ nickname: string; gameAccountId: string; isBot?: boolean }>;
};

type ActiveGameRow = {
  roomCode: string;
  matchId: string;
  phase: string;
  matchModeLabel: string;
  roundNumber: number;
  playerCount: number;
  players: Array<{ nickname: string; gameAccountId: string; hp: number; isBot: boolean }>;
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN");
}

function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

type AdminUserRow = { id: string; username: string; createdAt: number };

export default function AdminApp() {
  const [loginUsername, setLoginUsername] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("");
  const [currentUsername, setCurrentUsername] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [statusHint, setStatusHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");

  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");
  const [createUsername, setCreateUsername] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [adminList, setAdminList] = useState<AdminUserRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [spectateRoomCode, setSpectateRoomCode] = useState<string | null>(null);
  const [replayMatchId, setReplayMatchId] = useState<string | null>(null);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<AccountRow[]>([]);
  const [rooms, setRooms] = useState<AdminRoomPayload[]>([]);
  const [games, setGames] = useState<ActiveGameRow[]>([]);
  const [matches, setMatches] = useState<MatchHistoryItem[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardByMode | null>(null);
  const [lbMode, setLbMode] = useState<MatchMode>("solo");

  const refreshOverview = useCallback(async () => {
    const data = await adminFetch<Overview>("/overview");
    setOverview(data);
  }, []);

  const refreshUsers = useCallback(async () => {
    const data = await adminFetch<{ users: AccountRow[] }>("/game-accounts");
    setUsers(data.users);
  }, []);

  const refreshAdminList = useCallback(async () => {
    const data = await adminFetch<{ admins: AdminUserRow[] }>("/admins");
    setAdminList(data.admins);
  }, []);

  const refreshRooms = useCallback(async () => {
    const data = await adminFetch<{ rooms: AdminRoomPayload[] }>("/rooms");
    setRooms(data.rooms);
  }, []);

  const refreshGames = useCallback(async () => {
    const data = await adminFetch<{ games: ActiveGameRow[] }>("/games");
    setGames(data.games);
  }, []);

  const refreshMatches = useCallback(async () => {
    const data = await adminFetch<{ matches: MatchHistoryItem[] }>("/matches");
    setMatches(data.matches as MatchHistoryItem[]);
  }, []);

  const refreshLeaderboard = useCallback(async () => {
    const data = await adminFetch<{ leaderboard: LeaderboardByMode }>("/leaderboard");
    setLeaderboard(data.leaderboard);
  }, []);

  const reloadCurrentTab = useCallback(async () => {
    switch (tab) {
      case "overview":
        await refreshOverview();
        break;
      case "users":
        await refreshUsers();
        break;
      case "rooms":
        await refreshRooms();
        break;
      case "games":
        await refreshGames();
        break;
      case "matches":
        await refreshMatches();
        break;
      case "leaderboard":
        await refreshLeaderboard();
        break;
      case "adminAccounts":
        await refreshAdminList();
        break;
      default:
        break;
    }
  }, [
    tab,
    refreshOverview,
    refreshUsers,
    refreshRooms,
    refreshGames,
    refreshMatches,
    refreshLeaderboard,
    refreshAdminList,
  ]);

  const loadAuthorizedTab = useCallback(() => {
    setLoading(true);
    setError(null);
    void reloadCurrentTab()
      .catch((e) => {
        const err = e as Error & { code?: string };
        if (err.code === "UNAUTHORIZED") {
          setAuthorized(false);
          clearAdminToken();
          setError("登录已失效，请重新登录");
        } else {
          setError(err.message || "加载失败");
        }
      })
      .finally(() => setLoading(false));
  }, [reloadCurrentTab]);

  const submitLogin = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const r = await loginAdmin(loginUsername.trim(), loginPassword);
      saveAdminToken(r.token);
      setCurrentUsername(r.username);
      setLoginPassword("");
      setAuthorized(true);
    } catch (e) {
      setAuthorized(false);
      setError(e instanceof Error ? e.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }, [loginUsername, loginPassword]);

  useEffect(() => {
    void (async () => {
      const st = await fetchAdminStatus();
      if (st.hint) setStatusHint(st.hint);
    })();
  }, []);

  useEffect(() => {
    const t = loadAdminToken();
    if (!t) return;
    setLoading(true);
    setError(null);
    void adminFetch<{ username: string }>("/me")
      .then((me) => {
        setCurrentUsername(me.username);
        return refreshOverview();
      })
      .then(() => setAuthorized(true))
      .catch((e) => {
        const err = e as Error & { code?: string };
        if (err.code === "UNAUTHORIZED" || err.message === "UNAUTHORIZED") {
          clearAdminToken();
          setError("登录已失效，请重新登录");
        }
      })
      .finally(() => setLoading(false));
  }, [refreshOverview]);

  useEffect(() => {
    if (!authorized) return;
    loadAuthorizedTab();
  }, [authorized, tab, loadAuthorizedTab]);

  const logout = () => {
    void logoutAdmin().finally(() => {
      clearAdminToken();
      setAuthorized(false);
      setOverview(null);
      setCurrentUsername(null);
      setError(null);
    });
  };

  const submitChangePassword = async () => {
    if (newPassword !== newPassword2) {
      setError("两次输入的新密码不一致");
      return;
    }
    setError(null);
    try {
      await adminFetch("/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      setOldPassword("");
      setNewPassword("");
      setNewPassword2("");
      setError(null);
      setNotice("密码已更新");
      window.setTimeout(() => setNotice(null), 3200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "修改失败");
    }
  };

  const submitCreateAdmin = async () => {
    setError(null);
    try {
      await adminFetch("/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: createUsername.trim(), password: createPassword }),
      });
      setCreateUsername("");
      setCreatePassword("");
      await refreshAdminList();
      setNotice("已创建管理员");
      window.setTimeout(() => setNotice(null), 3200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    }
  };

  const deleteUser = async (id: string) => {
    if (!window.confirm(`确定删除账号「${id}」？`)) return;
    setError(null);
    try {
      await adminFetch(`/game-accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refreshUsers();
      await refreshOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const dissolveRoom = async (code: string) => {
    if (!window.confirm(`确定解散房间 ${code}？所有在线玩家将被移出。`)) return;
    setError(null);
    try {
      await adminFetch(`/rooms/${code}/dissolve`, { method: "POST" });
      await refreshRooms();
      await refreshGames();
      await refreshOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    }
  };

  const forceEnd = async (code: string) => {
    if (!window.confirm(`强制结束房间 ${code} 的进行中对局？将按当前局面结算并写入战绩（若无胜者可能无冠军）。`)) return;
    setError(null);
    try {
      await adminFetch(`/games/${code}/force-end`, { method: "POST" });
      await refreshGames();
      await refreshRooms();
      await refreshMatches();
      await refreshOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    }
  };

  const deleteMatch = async (matchId: string) => {
    if (!window.confirm("确定从库中删除该场已结束对局记录？排行榜统计将随之变化。")) return;
    setError(null);
    try {
      await adminFetch(`/matches/${encodeURIComponent(matchId)}`, { method: "DELETE" });
      await refreshMatches();
      await refreshLeaderboard();
      await refreshOverview();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  return (
    <div className="admin-root">
      <div className="admin-root__backdrop" aria-hidden />
      <div className="admin-layout">
        <header className="admin-top">
          <h1>黑暗森林 · 管理后台</h1>
          {authorized && currentUsername ? (
            <span className="admin-top__user admin-muted">当前：{currentUsername}</span>
          ) : null}
          <div className="admin-top__links">
            {authorized ? (
              <>
                <button
                  type="button"
                  className="admin-btn"
                  onClick={loadAuthorizedTab}
                  disabled={loading}
                >
                  刷新
                </button>
                <button type="button" className="admin-btn" onClick={logout}>
                  退出登录
                </button>
              </>
            ) : null}
            <a href="/">返回游戏首页</a>
          </div>
        </header>

        {!authorized ? (
          <div className="admin-login">
            <h2>管理员登录</h2>
            <p>
              使用管理员账号与密码登录。{statusHint ? ` ${statusHint}` : ""}
            </p>
            <label className="admin-label" htmlFor="admin-login-user">
              账号
            </label>
            <input
              id="admin-login-user"
              type="text"
              autoComplete="username"
              placeholder="admin"
              value={loginUsername}
              onChange={(e) => setLoginUsername(e.target.value)}
            />
            <label className="admin-label" htmlFor="admin-login-pass">
              密码
            </label>
            <input
              id="admin-login-pass"
              type="password"
              autoComplete="current-password"
              placeholder="密码"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submitLogin()}
            />
            {error ? <p className="admin-error">{error}</p> : null}
            <div className="admin-login__actions">
              <button type="button" className="btn-primary" disabled={loading} onClick={() => void submitLogin()}>
                {loading ? "登录中…" : "进入后台"}
              </button>
            </div>
            <p className="admin-muted" style={{ marginTop: 16 }}>
              首次部署且无管理员数据时，会自动创建默认账号{" "}
              <span className="admin-code">admin</span> /{" "}
              <span className="admin-code">123456</span>（请在登录后尽快修改密码）。
            </p>
          </div>
        ) : (
          <>
            <nav className="admin-tabs" aria-label="管理模块">
              {(
                [
                  ["overview", "总览"],
                  ["users", "用户管理"],
                  ["rooms", "房间管理"],
                  ["games", "进行中对局"],
                  ["matches", "对局记录"],
                  ["leaderboard", "排行榜"],
                  ["adminAccounts", "管理员账号"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={tab === id ? "admin-tabs__active" : ""}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </nav>

            {error ? <p className="admin-error">{error}</p> : null}
            {loading ? <p className="admin-hint">加载中…</p> : null}

            <section className="admin-panel">
              {tab === "overview" && overview && (
                <>
                  <h2>运行概览</h2>
                  <div className="admin-stats">
                    <div className="admin-stat">
                      <strong>{overview.roomCount}</strong>
                      <span>活跃房间</span>
                    </div>
                    <div className="admin-stat">
                      <strong>{overview.activeGameCount}</strong>
                      <span>进行中对局</span>
                    </div>
                    <div className="admin-stat">
                      <strong>{overview.accountCount}</strong>
                      <span>已登记账号</span>
                    </div>
                    <div className="admin-stat">
                      <strong>{overview.finishedMatchCount}</strong>
                      <span>已结束对局记录</span>
                    </div>
                  </div>
                  <p className="admin-hint" style={{ marginTop: 16 }}>
                    「进行中对局」与房间来自内存；「对局记录」与排行榜来自持久化文件 server-data/match-store.json。
                  </p>
                </>
              )}

              {tab === "users" && (
                <>
                  <h2>用户管理</h2>
                  <p className="admin-hint">删除账号仅移除登记信息，历史对局记录中的账号 ID 仍会保留。</p>
                  <div className="admin-table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>账号 ID</th>
                          <th>昵称</th>
                          <th>更新时间</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {users.map((u) => (
                          <tr key={u.gameAccountId}>
                            <td className="admin-code">{u.gameAccountId}</td>
                            <td>
                              <img className="admin-avatar" src={u.avatar || DEFAULT_AVATAR} alt="" />
                              {u.nickname}
                            </td>
                            <td>{formatTime(u.updatedAt)}</td>
                            <td>
                              <button
                                type="button"
                                className="admin-btn admin-btn--danger"
                                onClick={() => void deleteUser(u.gameAccountId)}
                              >
                                删除
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {users.length === 0 && !loading ? <p className="admin-muted">暂无账号</p> : null}
                </>
              )}

              {tab === "rooms" && (
                <>
                  <h2>房间管理</h2>
                  <p className="admin-hint">解散房间会踢出所有在线玩家并关闭房间（与「仅剩电脑」时的自动解散逻辑一致）。</p>
                  <div className="admin-table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>房间号</th>
                          <th>模式</th>
                          <th>对局进行中</th>
                          <th>玩家数</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {rooms.map((r) => (
                          <tr key={r.code}>
                            <td className="admin-code">{r.code}</td>
                            <td>{r.matchModeLabel}</td>
                            <td>{r.gameInProgress ? "是" : "否"}</td>
                            <td>{r.players.filter((p) => !p.isBot).length} 人 +{" "}
                              {r.players.filter((p) => p.isBot).length} 电脑</td>
                            <td>
                              <button type="button" className="admin-btn admin-btn--danger" onClick={() => void dissolveRoom(r.code)}>
                                解散房间
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {rooms.length === 0 && !loading ? <p className="admin-muted">暂无活跃房间</p> : null}
                </>
              )}

              {tab === "games" && (
                <>
                  <h2>进行中对局</h2>
                  <p className="admin-hint">
                    「实时观战」以观战者全图视野轮询刷新（约 1.2s）；「强制结束」将把本局标记为结束并写入战绩库。
                  </p>
                  <div className="admin-table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>房间</th>
                          <th>对局 ID</th>
                          <th>模式</th>
                          <th>回合</th>
                          <th>参与者</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {games.map((g) => (
                          <tr key={g.roomCode}>
                            <td className="admin-code">{g.roomCode}</td>
                            <td className="admin-code" style={{ maxWidth: 180, wordBreak: "break-all" }}>
                              {g.matchId}
                            </td>
                            <td>{g.matchModeLabel}</td>
                            <td>{g.roundNumber}</td>
                            <td>
                              {g.players.slice(0, 6).map((p) => p.nickname).join("、")}
                              {g.players.length > 6 ? "…" : ""}
                            </td>
                            <td>
                              <div className="admin-actions-cell">
                                <button type="button" className="admin-btn" onClick={() => setSpectateRoomCode(g.roomCode)}>
                                  实时观战
                                </button>
                                <button type="button" className="admin-btn admin-btn--danger" onClick={() => void forceEnd(g.roomCode)}>
                                  强制结束
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {games.length === 0 && !loading ? <p className="admin-muted">当前无进行中的对局</p> : null}
                </>
              )}

              {tab === "matches" && (
                <>
                  <h2>对局记录（持久化）</h2>
                  <p className="admin-hint">
                    「完整复盘」打开该局全部复盘日志与结算排名；删除记录会影响排行榜统计。
                  </p>
                  <div className="admin-table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>结束时间</th>
                          <th>房间</th>
                          <th>模式</th>
                          <th>对局 ID</th>
                          <th>名次摘要</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {matches.map((m) => (
                          <tr key={m.matchId}>
                            <td>{formatTime(m.endedAt)}</td>
                            <td className="admin-code">{m.roomCode}</td>
                            <td>{m.matchModeLabel ?? "—"}</td>
                            <td className="admin-code" style={{ maxWidth: 140, wordBreak: "break-all" }}>
                              {m.matchId}
                            </td>
                            <td>
                              {m.rankings
                                .slice(0, 4)
                                .map((r) => `${r.rank}.${r.nickname}`)
                                .join("；")}
                              {m.rankings.length > 4 ? "…" : ""}
                            </td>
                            <td>
                              <div className="admin-actions-cell">
                                <button type="button" className="admin-btn" onClick={() => setReplayMatchId(m.matchId)}>
                                  完整复盘
                                </button>
                                <button
                                  type="button"
                                  className="admin-btn admin-btn--danger"
                                  onClick={() => void deleteMatch(m.matchId)}
                                >
                                  删除记录
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {matches.length === 0 && !loading ? <p className="admin-muted">暂无已结束对局记录</p> : null}
                </>
              )}

              {tab === "adminAccounts" && (
                <>
                  <h2>管理员账号</h2>
                  {notice ? <p className="admin-notice">{notice}</p> : null}
                  <p className="admin-hint">
                    修改当前账号密码，或新建其他管理员（新密码至少 6 位）。管理员数据保存在服务端{" "}
                    <span className="admin-code">server-data/admins.json</span>。
                  </p>

                  <h3 className="admin-subheading">修改密码</h3>
                  <div className="admin-form-grid">
                    <label className="admin-label">原密码</label>
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={oldPassword}
                      onChange={(e) => setOldPassword(e.target.value)}
                    />
                    <label className="admin-label">新密码</label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                    <label className="admin-label">确认新密码</label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={newPassword2}
                      onChange={(e) => setNewPassword2(e.target.value)}
                    />
                  </div>
                  <button type="button" className="btn-primary" style={{ marginTop: 12 }} onClick={() => void submitChangePassword()}>
                    保存新密码
                  </button>

                  <h3 className="admin-subheading" style={{ marginTop: 28 }}>
                    新建管理员
                  </h3>
                  <div className="admin-form-grid">
                    <label className="admin-label">用户名</label>
                    <input
                      type="text"
                      autoComplete="off"
                      value={createUsername}
                      onChange={(e) => setCreateUsername(e.target.value)}
                      placeholder="1–32 位"
                    />
                    <label className="admin-label">初始密码</label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={createPassword}
                      onChange={(e) => setCreatePassword(e.target.value)}
                    />
                  </div>
                  <button type="button" className="btn-primary" style={{ marginTop: 12 }} onClick={() => void submitCreateAdmin()}>
                    创建管理员
                  </button>

                  <h3 className="admin-subheading" style={{ marginTop: 28 }}>
                    已有管理员
                  </h3>
                  <div className="admin-table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>用户名</th>
                          <th>创建时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminList.map((a) => (
                          <tr key={a.id}>
                            <td className="admin-code">{a.username}</td>
                            <td>{formatTime(a.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {adminList.length === 0 && !loading ? <p className="admin-muted">暂无数据</p> : null}
                </>
              )}

              {tab === "leaderboard" && leaderboard && (
                <>
                  <h2>排行榜管理</h2>
                  <p className="admin-hint">
                    数据由服务端根据有效对局实时聚合；删除「对局记录」中的场次后，于此处刷新即可看到变化。
                  </p>
                  <div className="leaderboard-tabs" role="tablist" style={{ marginBottom: 12 }}>
                    {MATCH_MODE_OPTIONS.map((mode) => (
                      <button
                        key={mode.mode}
                        type="button"
                        className={"leaderboard-tab" + (lbMode === mode.mode ? " leaderboard-tab--active" : "")}
                        onClick={() => setLbMode(mode.mode)}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                  <div className="admin-table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>玩家</th>
                          <th>胜局</th>
                          <th>场次</th>
                          <th>胜率</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(leaderboard[lbMode] ?? []).map((row, index) => (
                          <tr key={row.gameAccountId}>
                            <td>{index + 1}</td>
                            <td>
                              <img className="admin-avatar" src={row.avatar || DEFAULT_AVATAR} alt="" />
                              {row.nickname}
                              <span className="admin-muted admin-code" style={{ marginLeft: 8 }}>
                                {row.gameAccountId}
                              </span>
                            </td>
                            <td>{row.wins}</td>
                            <td>{row.games}</td>
                            <td>{formatRate(row.winRate)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {(leaderboard[lbMode] ?? []).length === 0 && !loading ? (
                    <p className="admin-muted">该模式下暂无可展示玩家（需满足有效对局条件且有胜场）。</p>
                  ) : null}
                </>
              )}
            </section>
            {spectateRoomCode ? (
              <AdminSpectateOverlay roomCode={spectateRoomCode} onClose={() => setSpectateRoomCode(null)} />
            ) : null}
            <AdminReplayModal
              matchId={replayMatchId}
              open={replayMatchId !== null}
              onClose={() => setReplayMatchId(null)}
            />
          </>
        )}
      </div>
    </div>
  );
}

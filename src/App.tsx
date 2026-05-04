import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { io, type Socket } from "socket.io-client";
import { AccountGateModal } from "@/components/AccountGateModal";
import { PlayerAvatarFrame } from "@/components/PlayerAvatarFrame";
import { LeaderboardModal } from "@/components/LeaderboardModal";
import { MatchHistoryModal } from "@/components/MatchHistoryModal";
import { RoomView } from "@/components/RoomView";
import { GameScreen } from "@/components/game/GameScreen";
import { SKILL_CATALOG } from "@/constants/skillCatalog";
import { ALLOWED_GRID_SIZES, mapSizeLabel, type AllowedGridSize } from "@/constants/mapSizes";
import { MATCH_MODE_OPTIONS, type MatchMode } from "@/constants/matchModes";
import type { GameClientState } from "@/types/game";
import type { BotDifficulty, RoomState, RoomGameSettings } from "@/types/room";
import { DEFAULT_AVATAR, normalizeAvatarUrl } from "@/utils/defaultAvatar";
import { fileToAvatarDataUrl } from "@/utils/fileToAvatarDataUrl";
import { randomFruitName } from "@/utils/fruits";
import { clearGameAccount, loadGameAccount, saveGameAccount } from "@/utils/gameAccount";
import { clearGameResume, readGameResume, saveGameResume } from "@/utils/gameSession";
import { fetchAccountProfile, registerAccountApi } from "@/utils/matchApi";
import { loadAvatar, loadNickname, saveAvatar, saveNickname } from "@/utils/storage";

function useSocket(): Socket {
  return useMemo(() => {
    const url = import.meta.env.VITE_SOCKET_URL || undefined;
    return io(url, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      autoConnect: true,
    });
  }, []);
}

export default function App() {
  const socket = useSocket();

  const [nickname, setNickname] = useState(() => loadNickname() || randomFruitName());
  const [avatar, setAvatar] = useState(() => normalizeAvatarUrl(loadAvatar()));

  const [room, setRoom] = useState<RoomState | null>(null);
  const [myId, setMyId] = useState<string>("");
  const [gameState, setGameState] = useState<GameClientState | null>(null);

  const [nickOpen, setNickOpen] = useState(false);
  const [nickDraft, setNickDraft] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [mapCreateOpen, setMapCreateOpen] = useState(false);
  const [pendingGridSize, setPendingGridSize] = useState<AllowedGridSize>(15);
  const [pendingMatchMode, setPendingMatchMode] = useState<MatchMode>("solo");
  const [createRoomCode, setCreateRoomCode] = useState("");

  const avatarFileInputRef = useRef<HTMLInputElement>(null);
  const [hostMenuFor, setHostMenuFor] = useState<string | null>(null);
  /** 房主点击空对战席时：弹框选「更换位置」或添加电脑 */
  const [hostEmptyBattleSlot, setHostEmptyBattleSlot] = useState<number | null>(null);

  const [toast, setToast] = useState<string | null>(null);
  const [gameLeaveNotice, setGameLeaveNotice] = useState<string | null>(null);

  const [sessionReady, setSessionReady] = useState(false);
  const [loggedInAccountId, setLoggedInAccountId] = useState<string | null>(null);
  const [accountSubmitting, setAccountSubmitting] = useState(false);
  const [accountGateError, setAccountGateError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [skillsGuideOpen, setSkillsGuideOpen] = useState(false);
  const [activeGamePrompt, setActiveGamePrompt] = useState<{ roomCode: string; resumeToken: string } | null>(null);
  const activeGameCheckedForRef = useRef<string | null>(null);
  /** 用于断线提示：是否在房间或局中（每帧刷新，disconnect 回调读取） */
  const hadRoomOrGameRef = useRef(false);

  const resumeGame = useCallback((saved: { roomCode: string; resumeToken: string }) => {
    if (!socket.connected) return;
    socket.emit(
      "game:resume",
      { roomCode: saved.roomCode, resumeToken: saved.resumeToken },
      (err: string | null) => {
        if (err) {
          clearGameResume();
          setToast(err);
        } else {
          saveGameResume(saved.roomCode, saved.resumeToken);
          setActiveGamePrompt(null);
        }
      }
    );
  }, [socket]);

  const tryResumeGame = useCallback(() => {
    const saved = readGameResume();
    if (!saved) return;
    resumeGame(saved);
  }, [resumeGame]);

  hadRoomOrGameRef.current = Boolean(room || gameState);

  useEffect(() => {
    let playerLeftClearTimer: number | null = null;

    const onConnect = () => {
      setMyId(socket.id || "");
      tryResumeGame();
    };
    const onRoomState = (s: RoomState) => {
      setRoom((prev) => ({
        ...s,
        waitingToSpectate: s.waitingToSpectate ?? prev?.waitingToSpectate,
      }));
      if (!s.gameInProgress) {
        setGameState((prev) => {
          if (prev?.phase === "ended") return prev;
          clearGameResume();
          return null;
        });
      }
    };
    const onGameLeftToRoom = () => {
      setGameState(null);
      clearGameResume();
    };
    const onGameInvalid = (p?: { message?: string }) => {
      setGameState(null);
      clearGameResume();
      setGameLeaveNotice(null);
      setToast(p?.message || "对局已失效，已返回房间");
    };
    const onLeft = () => {
      clearGameResume();
      setRoom(null);
      setGameState(null);
      setGameLeaveNotice(null);
    };
    const onRoomDissolved = (payload?: { message?: string }) => {
      clearGameResume();
      setRoom(null);
      setGameState(null);
      setGameLeaveNotice(null);
      if (payload?.message) setToast(payload.message);
    };
    const onKicked = () => {
      clearGameResume();
      setRoom(null);
      setGameState(null);
      setGameLeaveNotice(null);
      setToast("你已被房主移出房间");
    };
    const onGameState = (s: GameClientState) => {
      setGameState(s);
      if (s.myResumeToken && s.roomCode) saveGameResume(s.roomCode, s.myResumeToken);
      if (s.isSpectator) {
        setRoom((prev) => (prev ? { ...prev, waitingToSpectate: false } : prev));
      }
    };
    const onGamePlayerLeft = (p: { nickname: string }) => {
      if (playerLeftClearTimer) window.clearTimeout(playerLeftClearTimer);
      setGameLeaveNotice(`${p.nickname} 离开了游戏`);
      playerLeftClearTimer = window.setTimeout(() => {
        playerLeftClearTimer = null;
        setGameLeaveNotice(null);
      }, 5200);
    };
    const onDisconnect = () => {
      if (hadRoomOrGameRef.current) {
        setToast("连接中断，正在尝试重连…");
      }
    };
    const onConnectError = () => {
      setToast("无法连接服务器，请检查网络");
    };
    socket.on("connect", onConnect);
    socket.on("room:state", onRoomState);
    socket.on("game:leftToRoom", onGameLeftToRoom);
    socket.on("game:invalid", onGameInvalid);
    socket.on("room:left", onLeft);
    socket.on("room:dissolved", onRoomDissolved);
    socket.on("room:kicked", onKicked);
    socket.on("game:state", onGameState);
    socket.on("game:playerLeft", onGamePlayerLeft);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    if (socket.connected) {
      setMyId(socket.id || "");
      tryResumeGame();
    }
    return () => {
      socket.off("connect", onConnect);
      socket.off("room:state", onRoomState);
      socket.off("game:leftToRoom", onGameLeftToRoom);
      socket.off("game:invalid", onGameInvalid);
      socket.off("room:left", onLeft);
      socket.off("room:dissolved", onRoomDissolved);
      socket.off("room:kicked", onKicked);
      socket.off("game:state", onGameState);
      socket.off("game:playerLeft", onGamePlayerLeft);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      if (playerLeftClearTimer) window.clearTimeout(playerLeftClearTimer);
    };
  }, [socket, tryResumeGame]);

  useEffect(() => {
    if (!loggedInAccountId || !sessionReady || !socket.connected || gameState) return;
    if (readGameResume()) return;
    if (activeGameCheckedForRef.current === loggedInAccountId) return;
    activeGameCheckedForRef.current = loggedInAccountId;
    socket.emit(
      "game:activeForAccount",
      { gameAccountId: loggedInAccountId },
      (err: string | null, payload?: { roomCode: string; resumeToken: string }) => {
        if (err) {
          setToast(err);
          return;
        }
        if (payload) setActiveGamePrompt(payload);
      }
    );
  }, [loggedInAccountId, sessionReady, socket, gameState]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const id = loadGameAccount();
      if (!id) {
        if (!cancelled) setSessionReady(true);
        return;
      }
      try {
        const profile = await fetchAccountProfile(id);
        if (cancelled) return;
        if (profile) {
          setNickname(profile.nickname);
          saveNickname(profile.nickname);
          const nextAvatar = normalizeAvatarUrl(profile.avatar);
          setAvatar(nextAvatar);
          saveAvatar(nextAvatar);
          setLoggedInAccountId(id);
        } else {
          clearGameAccount();
          setLoggedInAccountId(null);
        }
      } catch {
        if (!cancelled) {
          setToast("无法校验账号，请检查网络后重试");
          setLoggedInAccountId(id);
        }
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const showNickModal = () => {
    setNickDraft(nickname);
    setNickOpen(true);
  };

  const confirmNick = () => {
    const next = nickDraft.trim() || nickname;
    setNickname(next);
    saveNickname(next);
    setNickOpen(false);
    if (loggedInAccountId) {
      void registerAccountApi({ gameAccountId: loggedInAccountId, nickname: next, avatar }).catch(() =>
        setToast("同步昵称到账号失败")
      );
    }
    if (room) {
      socket.emit("room:syncProfile", { nickname: next }, () => undefined);
    }
  };

  const applyUploadedAvatar = (dataUrl: string) => {
    setAvatar(dataUrl);
    saveAvatar(dataUrl);
    if (loggedInAccountId) {
      void registerAccountApi({ gameAccountId: loggedInAccountId, nickname, avatar: dataUrl }).catch(() =>
        setToast("同步头像到账号失败")
      );
    }
    if (room) {
      socket.emit("room:syncProfile", { avatar: dataUrl }, () => undefined);
    }
  };

  const onAvatarFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      applyUploadedAvatar(dataUrl);
    } catch {
      setToast("无法读取该图片，请换一张试试");
    }
  };

  const leaveRoom = useCallback(() => {
    clearGameResume();
    socket.emit("room:leave");
    setRoom(null);
    setGameState(null);
    setGameLeaveNotice(null);
    setHostEmptyBattleSlot(null);
  }, [socket]);

  const enterSpectate = useCallback(() => {
    socket.emit("spectate:enter", (err: string | null) => {
      if (err) setToast(err);
    });
  }, [socket]);

  const openCreateRoomModal = () => {
    if (!loggedInAccountId) {
      setToast("请先登录游戏账号");
      return;
    }
    setPendingGridSize(15);
    setPendingMatchMode("solo");
    setCreateRoomCode("");
    setMapCreateOpen(true);
  };

  const confirmCreateRoom = () => {
    const code = createRoomCode.replace(/\D/g, "").slice(0, 4);
    if (code.length !== 4) {
      setToast("请输入4位数字房间号");
      return;
    }
    const gid = loggedInAccountId;
    if (!gid) return;
    socket.emit(
      "room:create",
      { nickname, avatar, gameAccountId: gid, gridSize: pendingGridSize, matchMode: pendingMatchMode, code },
      (err: string | null, state?: RoomState) => {
        if (err || !state) {
          setToast(err || "创建失败");
          return;
        }
        setMapCreateOpen(false);
        setRoom(state);
      }
    );
  };

  const setGridSizeForRoom = useCallback(
    (size: number) => {
      socket.emit("room:setGridSize", size, (err: string | null) => {
        if (err) setToast(err);
      });
    },
    [socket]
  );

  const setMatchModeForRoom = useCallback(
    (mode: MatchMode) => {
      socket.emit("room:setMatchMode", mode, (err: string | null) => {
        if (err) setToast(err);
      });
    },
    [socket]
  );

  const setGameSettingsForRoom = useCallback(
    (patch: Partial<RoomGameSettings>) => {
      socket.emit("room:setGameSettings", patch, (err: string | null) => {
        if (err) setToast(err);
      });
    },
    [socket]
  );

  const retireToLobby = useCallback(() => {
    socket.emit("game:retireToLobby", (err: string | null) => {
      if (err) setToast(err);
    });
  }, [socket]);

  const dismissGameEnd = useCallback(() => {
    setGameState(null);
    clearGameResume();
  }, []);

  const openJoin = () => {
    setJoinCode("");
    setJoinOpen(true);
  };

  const submitJoin = () => {
    const code = joinCode.replace(/\D/g, "").slice(0, 4);
    if (code.length !== 4) {
      setToast("请输入4位数字房间号");
      return;
    }
    const gid = loggedInAccountId;
    if (!gid) {
      setToast("请先登录游戏账号");
      return;
    }
    socket.emit("room:join", { code, nickname, avatar, gameAccountId: gid }, (err: string | null, state?: RoomState) => {
      if (err || !state) {
        setToast(err || "加入失败");
        return;
      }
      setJoinOpen(false);
      setRoom(state);
    });
  };

  const pickSlot = (slotIndex: number) => {
    socket.emit("room:setSlot", slotIndex, (err: string | null) => {
      if (err) setToast(err);
    });
  };

  const pickSpectatorSlot = useCallback(
    (slotIndex: number) => {
      socket.emit("room:setSpectatorSlot", slotIndex, (err: string | null) => {
        if (err) setToast(err);
      });
    },
    [socket]
  );

  const openHostEmptyBattleSlotMenu = useCallback((slotIndex: number) => {
    setHostEmptyBattleSlot(slotIndex);
  }, []);

  const confirmSwapToEmptyBattleSlot = useCallback(() => {
    if (hostEmptyBattleSlot === null) return;
    const slot = hostEmptyBattleSlot;
    socket.emit("room:setSlot", slot, (err: string | null) => {
      if (err) setToast(err);
      setHostEmptyBattleSlot(null);
    });
  }, [socket, hostEmptyBattleSlot]);

  const addRoomBot = useCallback(
    (difficulty: BotDifficulty) => {
      if (hostEmptyBattleSlot === null) return;
      const slot = hostEmptyBattleSlot;
      socket.emit(
        "room:addBot",
        { slotIndex: slot, difficulty },
        (err: string | null) => {
          if (err) setToast(err);
          setHostEmptyBattleSlot(null);
        }
      );
    },
    [socket, hostEmptyBattleSlot]
  );

  const startGame = () => {
    socket.emit("room:start", (err: string | null) => {
      if (err) setToast(err);
    });
  };

  const transferHost = (targetId: string) => {
    socket.emit("room:transferHost", targetId, (err: string | null) => {
      if (err) setToast(err);
      else setHostMenuFor(null);
    });
  };

  const kickPlayer = (targetId: string) => {
    socket.emit("room:kick", targetId, (err: string | null) => {
      if (err) setToast(err);
      else setHostMenuFor(null);
    });
  };

  const swapSeatWithPlayer = (targetId: string) => {
    socket.emit("room:swapSeatWith", targetId, (err: string | null) => {
      if (err) setToast(err);
      else setHostMenuFor(null);
    });
  };

  const isHost = room && room.hostId === myId;

  const showAccountGate = sessionReady && !loggedInAccountId;

  const onAccountGateSubmit = async (payload: { gameAccountId: string; nickname: string; avatar: string }) => {
    setAccountSubmitting(true);
    setAccountGateError(null);
    try {
      const gameAccountId = payload.gameAccountId.trim();
      const existing = await fetchAccountProfile(gameAccountId);
      const profile = existing ?? {
        gameAccountId,
        nickname: payload.nickname,
        avatar: payload.avatar,
      };
      if (!existing) {
        await registerAccountApi(profile);
      }
      saveGameAccount(gameAccountId);
      saveNickname(profile.nickname);
      saveAvatar(profile.avatar);
      setNickname(profile.nickname);
      setAvatar(profile.avatar);
      setLoggedInAccountId(gameAccountId);
    } catch (e) {
      setAccountGateError(e instanceof Error ? e.message : "登记失败");
    } finally {
      setAccountSubmitting(false);
    }
  };

  const logout = () => {
    clearGameAccount();
    setLoggedInAccountId(null);
    setActiveGamePrompt(null);
    activeGameCheckedForRef.current = null;
    setHistoryOpen(false);
    if (room || gameState) leaveRoom();
  };

  return (
    <div className="app-shell">
      <div className="app-home home-hub">
        <div className="home-hub__backdrop" aria-hidden="true">
          <div className="home-hub__aurora" />
          <div className="home-hub__gridlines" />
          <div className="home-hub__noise" />
          <div className="home-hub__vignette" />
        </div>

        {!room ? (
          <a className="home-hub__admin-corner" href="/admin">
            管理后台
          </a>
        ) : null}

        <header className="home-hub__top">
          <button
            type="button"
            className="avatar-btn avatar-btn--hub"
            title={loggedInAccountId ? "点击上传头像" : "登录后可上传头像"}
            onClick={() => loggedInAccountId && avatarFileInputRef.current?.click()}
            aria-label="头像"
            disabled={!loggedInAccountId}
          >
            {room && isHost && <span className="crown-badge">👑</span>}
            <PlayerAvatarFrame src={avatar || DEFAULT_AVATAR} alt="" variant="fill" />
          </button>
          <input
            ref={avatarFileInputRef}
            type="file"
            accept="image/*"
            className="home-hub__avatar-file"
            aria-hidden
            tabIndex={-1}
            onChange={onAvatarFileChange}
          />
          <div className="home-hub__who">
            <span className="home-hub__who-label">昵称</span>
            <span className="home-hub__who-name" title={nickname}>
              {nickname}
            </span>
            {loggedInAccountId ? (
              <div className="home-hub__who-actions" role="group" aria-label="账号操作">
                <button type="button" className="home-hub__mini" onClick={showNickModal}>
                  修改
                </button>
                <span className="home-hub__mini-sep" aria-hidden>
                  ·
                </span>
                <button type="button" className="home-hub__mini home-hub__mini--muted" onClick={logout}>
                  退出
                </button>
              </div>
            ) : (
              <span className="home-hub__who-note">登录后可创建 / 加入房间</span>
            )}
          </div>
        </header>

        <main className="home-hub__main">
          <section className="home-hub__hero" aria-labelledby="home-title">
            <p className="home-hub__eyebrow">网格战术 · 明暗博弈</p>
            <h1 id="home-title" className="home-hub__title">
              黑暗森林
            </h1>
            <p className="home-hub__lede">
              危机四伏的迷雾中，你是猎人也是猎物。有限的视野、未知的坐标——隐藏自己，猎杀目标，站到最后。
            </p>
            <div className="home-hub__hero-actions">
              <button type="button" className="home-hub__rules" onClick={() => setRulesOpen(true)}>
                游戏规则
              </button>
              <button type="button" className="home-hub__rules home-hub__rules--secondary" onClick={() => setSkillsGuideOpen(true)}>
                技能介绍
              </button>
            </div>
          </section>

          <nav className="home-hub__nav" aria-label="首页功能">
            <button
              type="button"
              className="hub-tile hub-tile--create"
              onClick={openCreateRoomModal}
              disabled={!!room || !loggedInAccountId}
            >
              <span className="hub-tile__glyph" aria-hidden="true" />
              <span className="hub-tile__text">
                <span className="hub-tile__name">创建房间</span>
                <span className="hub-tile__sub">
                  <span className="hub-tile__sub-line">房间号 · 地图尺寸</span>
                  <span className="hub-tile__sub-line">对局类型开局前可改</span>
                </span>
              </span>
            </button>
            <button
              type="button"
              className="hub-tile hub-tile--join"
              onClick={openJoin}
              disabled={!!room || !loggedInAccountId}
            >
              <span className="hub-tile__glyph" aria-hidden="true" />
              <span className="hub-tile__text">
                <span className="hub-tile__name">加入房间</span>
                <span className="hub-tile__sub">
                  <span className="hub-tile__sub-line">输入四位房间码</span>
                  <span className="hub-tile__sub-line">加入他人房间</span>
                </span>
              </span>
            </button>
            <button
              type="button"
              className="hub-tile hub-tile--history"
              onClick={() => setHistoryOpen(true)}
              disabled={!loggedInAccountId}
            >
              <span className="hub-tile__glyph" aria-hidden="true" />
              <span className="hub-tile__text">
                <span className="hub-tile__name">对局记录</span>
                <span className="hub-tile__sub">
                  <span className="hub-tile__sub-line">个人历史战绩</span>
                  <span className="hub-tile__sub-line">单场详情回放</span>
                </span>
              </span>
            </button>
            <button type="button" className="hub-tile hub-tile--rank" onClick={() => setLeaderboardOpen(true)}>
              <span className="hub-tile__glyph" aria-hidden="true" />
              <span className="hub-tile__text">
                <span className="hub-tile__name">排行榜</span>
                <span className="hub-tile__sub">
                  <span className="hub-tile__sub-line">仅真人猎人统计</span>
                  <span className="hub-tile__sub-line">按对局类型分列</span>
                </span>
              </span>
            </button>
          </nav>
        </main>
      </div>

      <AccountGateModal
        open={showAccountGate}
        initialNickname={nickname}
        initialAvatar={avatar}
        submitting={accountSubmitting}
        error={accountGateError}
        onSubmit={onAccountGateSubmit}
      />

      {loggedInAccountId ? (
        <MatchHistoryModal
          open={historyOpen}
          gameAccountId={loggedInAccountId}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}

      <LeaderboardModal open={leaderboardOpen} onClose={() => setLeaderboardOpen(false)} />

      {skillsGuideOpen && (
        <div className="overlay" role="dialog" aria-modal="true" onClick={() => setSkillsGuideOpen(false)}>
          <div className="modal modal--skills" onClick={(e) => e.stopPropagation()}>
            <h3>技能介绍</h3>
            <p className="modal-hint" style={{ marginTop: -4 }}>
              以下为当前版本全部技能；消耗、冷却与效果以局内实际判定为准。
            </p>
            <div className="skills-guide-list">
              {SKILL_CATALOG.map((entry) => (
                <article key={entry.id} className="skills-guide-item">
                  <h4 className="skills-guide-item__title">{entry.title}</h4>
                  <p className="skills-guide-item__meta">{entry.metaLine}</p>
                  <p className="skills-guide-item__effect">{entry.effect}</p>
                </article>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setSkillsGuideOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {rulesOpen && (
        <div className="overlay" role="dialog" aria-modal="true" onClick={() => setRulesOpen(false)}>
          <div className="modal modal--rules" onClick={(e) => e.stopPropagation()}>
            <h3>游戏规则</h3>
            <div className="rules-content">
              <p>
                各位猎人们，你们身处一片黑暗的森林，森林中，危机与机遇共存，你们既是猎人，也是猎物。
                隐藏自己，淘汰所有其他猎人，取得最终的胜利。
              </p>
              <h4>游戏规则：</h4>
              <p>（1）所有玩家在网格地图内随机出生，每位玩家不知道其他敌对玩家的具体位置，除非其他玩家出现在自己2格视野范围内。</p>
              <p>（2）玩家行动是按照第一位玩家开始顺序依次进行的。</p>
              <p>（3）每位玩家初始拥有5体力，体力每回合恢复2点，体力上限为10点。</p>
              <p>（4）每位玩家初始拥有10点生命值，生命值归0则淘汰出局。</p>
              <p>（5）地图上将随机出现天灾、怪物等各种随机事件，请小心谨慎。</p>
              <h4>每回合可以选择的操作有：</h4>
              <p>1.攻击：对指定一个格子发起进攻，消耗其3点生命值，消耗自身2点体力。（单回合攻击、休息、技能只能选择一项）</p>
              <p>2.移动：可沿水平、垂直移动，每移动一格消耗1体力。</p>
              <p>3.休息：本回合恢复3点体力或1生命。（选择休息则无法选择其他任何选项，也无法移动）</p>
              <p>
                4.学习：消耗3体力，随机学习一项技能，最多同时拥有5项技能，满5项后继续学习可随机替换一个新的技能。每回合最多学习两次。
              </p>
              <p>5.技能：每回合最多只能使用两次技能，不能使用相同的技能。</p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setRulesOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {activeGamePrompt && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>重新加入游戏？</h3>
            <p className="modal-hint">
              房间号 {activeGamePrompt.roomCode} 的游戏还在继续，您是否要重新加入游戏？
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setActiveGamePrompt(null)}>
                暂不加入
              </button>
              <button type="button" className="btn-primary" onClick={() => resumeGame(activeGamePrompt)}>
                重新加入
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast-layer" role="status" aria-live="polite">
          <div className="toast-inner">{toast}</div>
        </div>
      )}

      {mapCreateOpen && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="modal modal--account">
            <h3>创建房间</h3>
            <p className="modal-hint">输入4位数字房间号，并选择对局类型和地图尺寸。</p>
            <input
              className="join-code-input"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              placeholder="房间号"
              value={createRoomCode}
              onChange={(e) => setCreateRoomCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
              autoFocus
            />
            <p className="modal-hint" style={{ marginTop: 12 }}>
              创建后房主仍可在房间内、开局前修改对局类型和地图尺寸。
            </p>
            <div className="room-map-picker" style={{ marginBottom: 8 }}>
              <span className="room-map-picker__label">对局类型</span>
              {MATCH_MODE_OPTIONS.map((mode) => (
                <button
                  key={mode.mode}
                  type="button"
                  className={"room-map-chip" + (pendingMatchMode === mode.mode ? " room-map-chip--active" : "")}
                  onClick={() => setPendingMatchMode(mode.mode)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <div className="room-map-picker" style={{ marginBottom: 8 }}>
              <span className="room-map-picker__label">地图尺寸</span>
              {ALLOWED_GRID_SIZES.map((sz) => (
                <button
                  key={sz}
                  type="button"
                  className={"room-map-chip" + (pendingGridSize === sz ? " room-map-chip--active" : "")}
                  onClick={() => setPendingGridSize(sz)}
                >
                  {mapSizeLabel(sz)}
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setMapCreateOpen(false)}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={confirmCreateRoom}>
                创建房间
              </button>
            </div>
          </div>
        </div>
      )}

      {nickOpen && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>更改昵称</h3>
            <input
              value={nickDraft}
              onChange={(e) => setNickDraft(e.target.value)}
              placeholder="输入新昵称"
              maxLength={16}
              autoFocus
            />
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setNickOpen(false)}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={confirmNick}>
                确认修改
              </button>
            </div>
          </div>
        </div>
      )}

      {joinOpen && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>加入房间</h3>
            <input
              className="join-code-input"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              placeholder="0000"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
              autoFocus
            />
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setJoinOpen(false)}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={submitJoin}>
                加入房间
              </button>
            </div>
          </div>
        </div>
      )}

      {hostEmptyBattleSlot !== null && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>空席位</h3>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: -8 }}>
              对战席 {hostEmptyBattleSlot + 1}：入座本席或与电脑对战
            </p>
            <div className="modal-actions" style={{ flexDirection: "column" }}>
              <button type="button" className="btn-secondary" onClick={confirmSwapToEmptyBattleSlot}>
                更换位置
              </button>
              <button type="button" className="btn-secondary" onClick={() => addRoomBot("easy")}>
                添加初级电脑
              </button>
              <button type="button" className="btn-secondary" onClick={() => addRoomBot("medium")}>
                添加中级电脑
              </button>
              <button type="button" className="btn-secondary" onClick={() => addRoomBot("hard")}>
                添加高级电脑
              </button>
              <button type="button" className="btn-secondary" onClick={() => setHostEmptyBattleSlot(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {hostMenuFor && room && (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>房主操作</h3>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: -8 }}>
              对玩家「{room.players.find((p) => p.socketId === hostMenuFor)?.nickname ?? ""}」
            </p>
            <div className="modal-actions" style={{ flexDirection: "column" }}>
              <button type="button" className="btn-secondary" onClick={() => swapSeatWithPlayer(hostMenuFor)}>
                更换位置
              </button>
              <button type="button" className="btn-secondary" onClick={() => transferHost(hostMenuFor)}>
                转交房主
              </button>
              <button type="button" className="btn-danger" onClick={() => kickPlayer(hostMenuFor)}>
                踢出房间
              </button>
              <button type="button" className="btn-secondary" onClick={() => setHostMenuFor(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {room && myId && gameState && (
        <GameScreen
          state={gameState}
          myId={myId}
          socket={socket}
          onLeaveRoom={leaveRoom}
          onRetireToLobby={retireToLobby}
          onDismissGameEnd={dismissGameEnd}
          playerLeftBanner={gameLeaveNotice}
          onActionError={(msg) => setToast(msg)}
          onActionSuccess={(msg) => setToast(msg)}
        />
      )}
      {room && myId && !gameState && (
        <RoomView
          state={room}
          myId={myId}
          onLeave={leaveRoom}
          onStart={startGame}
          onPickSlot={pickSlot}
          onPickSpectatorSlot={pickSpectatorSlot}
          onHostPickEmptyBattleSlot={room.hostId === myId ? openHostEmptyBattleSlotMenu : undefined}
          onHostManagePlayer={(id) => setHostMenuFor(id)}
          onSpectate={enterSpectate}
          onSetGridSize={setGridSizeForRoom}
          onSetMatchMode={setMatchModeForRoom}
          onSetGameSettings={setGameSettingsForRoom}
        />
      )}
    </div>
  );
}

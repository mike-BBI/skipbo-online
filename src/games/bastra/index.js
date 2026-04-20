import { createGame, applyAction, MAX_PLAYERS, MIN_PLAYERS, DEFAULT_RULES } from './engine.js';
import { cpuPlan } from './bot.js';
import { Game } from './Game.jsx';
import { Lobby } from './Lobby.jsx';

export const bastraGame = {
  id: 'bastra',
  name: 'Bastra',
  createGame,
  applyAction,
  cpuPlan,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  defaultRules: { ...DEFAULT_RULES },
  // Bastra is deliberative — each play can trigger a multi-card
  // capture, and watching the CPU work through the board is part of
  // the strategy. Delays here are long intentionally.
  botActionDelay: () => 2800,
  botBetweenTurns: 1600,
  Game,
  Lobby,
};

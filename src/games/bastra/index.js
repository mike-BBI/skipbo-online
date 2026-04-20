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
  // Bastra is deliberative — the CPU "thinks" before each action and
  // the capture animation (1.7s) plays after. Randomized think time
  // so a CPU doesn't feel mechanical; between-turns kept small so
  // CPU→CPU transitions feel consistent with user→CPU transitions.
  botActionDelay: () => 1800 + Math.random() * 1400,  // 1.8–3.2s
  botBetweenTurns: 500,
  Game,
  Lobby,
};

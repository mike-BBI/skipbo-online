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
  // Each turn is a single card play — give the move time to land so
  // players can track the capture (or lack thereof) before the next
  // seat goes.
  botActionDelay: () => 1800,
  botBetweenTurns: 1100,
  Game,
  Lobby,
};

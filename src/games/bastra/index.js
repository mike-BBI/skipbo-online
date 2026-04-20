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
  botActionDelay: () => 900,
  botBetweenTurns: 500,
  Game,
  Lobby,
};

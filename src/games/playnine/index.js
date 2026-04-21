import { createGame, applyAction, MAX_PLAYERS, MIN_PLAYERS, DEFAULT_RULES } from './engine.js';
import { cpuPlan } from './bot.js';
import { Game } from './Game.jsx';
import { Lobby } from './Lobby.jsx';

export const playnineGame = {
  id: 'playnine',
  name: 'Play Nine',
  createGame,
  applyAction,
  cpuPlan,
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  defaultRules: { ...DEFAULT_RULES },
  // Tee-off flips are quick; normal draw+replace actions get a longer
  // think so the CPU feels deliberate without being sluggish. 600-800ms
  // for flips, 1.3–2.2s for play actions.
  botActionDelay: (action) => {
    if (!action) return 1200;
    if (action.type === 'teeOffFlip') return 500 + Math.random() * 250;
    if (action.type === 'drawDeck' || action.type === 'drawDiscard') return 900 + Math.random() * 500;
    return 1100 + Math.random() * 800;
  },
  botBetweenTurns: 400,
  Game,
  Lobby,
};

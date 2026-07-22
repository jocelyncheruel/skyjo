import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { BookOpen, Check, ChevronRight, RotateCcw, X } from 'lucide-react';
import Card from './Card.jsx';
import CardMotionLayer from './CardMotionLayer.jsx';
import {
  ActionDrawModal,
  ActionHandDock,
  ActionTile,
  PileButton,
} from './GameTablePieces.jsx';
import PlayerBoard from './PlayerBoard.jsx';
import { ACTION_GUIDE_CARDS } from '../gameGuide.js';
import {
  createTutorialGame,
  tutorialGameReducer,
  tutorialProgress,
  tutorialSelectableSlots,
  TUTORIAL_EVENTS,
  TUTORIAL_PHASES,
} from '../tutorialGame.js';

const GUIDE_TABS = [
  { id: 'rules', label: 'Skyjo' },
  { id: 'action', label: 'Skyjo Action' },
  { id: 'cards', label: 'Cartes Action' },
];

const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function keepFocusInDialog(event, dialog) {
  if (event.key !== 'Tab' || !dialog) return;
  const focusable = [...dialog.querySelectorAll(DIALOG_FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

function RulebookBoard({ action = false }) {
  const cards = action
    ? [null, null, { value: 0, kind: 'star' }, null, null, { value: 3 }, null, null, { value: -1 }, null, null, null]
    : [null, null, { value: -2 }, null, { value: 12 }, null, null, null, null, null, null, null];
  return (
    <div className={`sj-rulebook-board ${action ? 'sj-rulebook-board-action' : ''}`} aria-hidden="true">
      {cards.map((card, index) => (
        <Card
          key={index}
          value={card?.value}
          kind={card?.kind || 'number'}
          faceUp={Boolean(card)}
          removed={false}
          size="table"
          suppressRevealAnimation
        />
      ))}
    </div>
  );
}

function RulebookSection({ title, children, accent = false }) {
  return (
    <section className={`sj-rulebook-section ${accent ? 'sj-rulebook-section-accent' : ''}`}>
      <h3>{title}</h3>
      <div className="sj-rulebook-section-content">{children}</div>
    </section>
  );
}

function RuleChoice({ number, title, children, tone = 'green' }) {
  return (
    <article className={`sj-rulebook-choice sj-rulebook-choice-${tone}`}>
      <span>{number}</span>
      <div><strong>{title}</strong><p>{children}</p></div>
    </article>
  );
}

export function GameGuideButton({ onClick }) {
  return (
    <button type="button" className="sj-guide-open-button" onClick={onClick} aria-haspopup="dialog">
      <BookOpen aria-hidden="true" size={19} />
      <span>Comment jouer ?</span>
    </button>
  );
}

export function GameGuideModal({ open, gameMode = 'classic', onClose, onStartTutorial }) {
  const modeTab = gameMode === 'action' ? 'action' : 'rules';
  const [activeTab, setActiveTab] = useState(modeTab);
  const modalRef = useRef(null);
  const scrollRef = useRef(null);
  const tabRefs = useRef(new Map());

  const selectTab = (tabId) => {
    setActiveTab(tabId);
    scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleTabKeyDown = (event, tabIndex) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let nextIndex = tabIndex;
    if (event.key === 'ArrowLeft') nextIndex = (tabIndex - 1 + GUIDE_TABS.length) % GUIDE_TABS.length;
    if (event.key === 'ArrowRight') nextIndex = (tabIndex + 1) % GUIDE_TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = GUIDE_TABS.length - 1;
    const nextTab = GUIDE_TABS[nextIndex];
    selectTab(nextTab.id);
    tabRefs.current.get(nextTab.id)?.focus();
  };

  useEffect(() => {
    if (!open) return;
    setActiveTab(modeTab);
  }, [modeTab, open]);

  useEffect(() => {
    if (!open) return undefined;
    modalRef.current?.focus({ preventScroll: true });
    scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      const activeDialog = document.querySelector('.sj-tutorial-action-overlay [role="dialog"]')
        || modalRef.current;
      keepFocusInDialog(event, activeDialog);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="sj-modal-overlay sj-guide-overlay sj-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="sj-guide-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="game-guide-title"
        tabIndex={-1}
      >
        <header className="sj-guide-head">
          <div>
            <span className="sj-guide-kicker">Livret de règles</span>
            <h2 id="game-guide-title">Comment jouer ?</h2>
          </div>
          <button
            type="button"
            className="sj-profile-close"
            onClick={onClose}
            aria-label="Fermer les règles"
            title="Fermer"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </header>

        <div className="sj-guide-tabs" role="tablist" aria-label="Sections du guide">
          {GUIDE_TABS.map((tab, index) => (
            <button
              key={tab.id}
              ref={(node) => {
                if (node) tabRefs.current.set(tab.id, node);
                else tabRefs.current.delete(tab.id);
              }}
              id={`game-guide-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`game-guide-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              className={activeTab === tab.id ? 'sj-guide-tab-active' : ''}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div ref={scrollRef} className="sj-guide-scroll">
          {activeTab === 'rules' && (
            <div
              id="game-guide-panel-rules"
              className="sj-guide-section sj-rulebook-page sj-rulebook-classic"
              role="tabpanel"
              aria-labelledby="game-guide-tab-rules"
            >
              <RulebookSection title="But du jeu">
                <p>La partie se déroule en plusieurs manches. Essayez d’obtenir le moins de points possible en remplaçant les fortes valeurs de votre plateau.</p>
                <p><strong>La partie s’arrête dès qu’un joueur atteint 100 points ou plus.</strong> Le plus petit total remporte la partie. Si plusieurs joueurs partagent ce total, la partie se termine sur une égalité.</p>
              </RulebookSection>

              <RulebookSection title="Préparation d’une manche">
                <div className="sj-rulebook-illustrated">
                  <ul>
                    <li>Chaque joueur reçoit <strong>12 cartes face cachée</strong>.</li>
                    <li>Disposez-les en <strong>4 colonnes de 3 cartes</strong>.</li>
                    <li>Une carte visible forme la défausse ; le reste constitue la pioche.</li>
                    <li>Chaque joueur révèle <strong>2 cartes de son choix</strong>.</li>
                  </ul>
                  <div>
                    <RulebookBoard />
                    <small>Exemple de plateau de départ</small>
                  </div>
                </div>
              </RulebookSection>

              <RulebookSection title="Début d’une manche">
                <p>Le joueur dont les deux cartes visibles donnent la somme la plus élevée commence. Les tours se poursuivent ensuite dans l’ordre de la table.</p>
                <div className="sj-rulebook-example"><strong>Exemple</strong> 12 + (-2) = 10 : ce total commence devant 4 + 2 = 6.</div>
              </RulebookSection>

              <RulebookSection title="Déroulement d’un tour">
                <p>À votre tour, choisissez l’une des deux piles :</p>
                <div className="sj-rulebook-choices">
                  <RuleChoice number="1" title="Prendre la défausse">
                    Prenez la carte visible et échangez-la immédiatement avec une carte visible ou cachée de votre plateau. La nouvelle carte reste face visible.
                  </RuleChoice>
                  <RuleChoice number="2" title="Piocher une carte cachée">
                    Regardez la carte. Gardez-la en l’échangeant avec l’une des vôtres, ou défaussez-la puis révélez une carte cachée de votre plateau.
                  </RuleChoice>
                </div>
              </RulebookSection>

              <RulebookSection title="Règle du Skyjo" accent>
                <div className="sj-rulebook-skyjo-rule">
                  <div className="sj-rulebook-skyjo-visual" aria-hidden="true">
                    <div className="sj-rulebook-column">
                      {[0, 1, 2].map((index) => (
                        <Card key={index} value={9} faceUp size="pile" suppressRevealAnimation />
                      ))}
                    </div>
                    <span className="sj-rulebook-skyjo-result">
                      <strong>Colonne retirée</strong>
                      <small>0 point</small>
                    </span>
                  </div>
                  <div className="sj-rulebook-skyjo-copy">
                    <p>Dès que les <strong>3 cartes visibles d’une même colonne</strong> ont une valeur identique, retirez immédiatement la colonne.</p>
                    <ul>
                      <li>La règle s’applique aussi après le remplacement d’une carte.</li>
                      <li>Les trois emplacements restent vides jusqu’à la fin de la manche.</li>
                      <li>Les cartes retirées ne comptent plus dans votre score.</li>
                    </ul>
                  </div>
                </div>
              </RulebookSection>

              <RulebookSection title="Fin d’une manche et décompte">
                <ul>
                  <li>Dès qu’un joueur a révélé toutes ses cartes, les joueurs suivants effectuent encore un dernier tour.</li>
                  <li>Les cartes encore cachées sont révélées et toutes les valeurs restantes sont additionnées.</li>
                  <li>Si le joueur qui a terminé n’obtient pas <strong>strictement le plus petit score</strong>, ses points positifs de la manche sont doublés.</li>
                </ul>
                <div className="sj-rulebook-warning"><strong>Attention</strong> Le doublement ne s’applique jamais à un score nul ou négatif.</div>
              </RulebookSection>
            </div>
          )}

          {activeTab === 'action' && (
            <div
              id="game-guide-panel-action"
              className="sj-guide-section sj-rulebook-page sj-rulebook-action"
              role="tabpanel"
              aria-labelledby="game-guide-tab-action"
            >
              <RulebookSection title="But du jeu">
                <p>L’objectif reste le même : terminer la partie avec le plus petit score. Les cartes Étoile et Action ajoutent de nouvelles façons de transformer les plateaux.</p>
              </RulebookSection>

              <RulebookSection title="Préparation du jeu">
                <div className="sj-rulebook-illustrated sj-rulebook-action-setup">
                  <ul>
                    <li>La pioche de jeu réunit les cartes Chiffre et les cartes Étoile.</li>
                    <li>Les cartes Action forment une seconde pioche.</li>
                    <li>Quatre cartes Action visibles constituent le marché.</li>
                    <li>Chaque joueur prépare son plateau de 12 cartes et en révèle deux.</li>
                  </ul>
                  <div>
                    <RulebookBoard action />
                  </div>
                </div>
              </RulebookSection>

              <RulebookSection title="Déroulement d’un tour">
                <p>Au début de votre tour, deux possibilités s’offrent à vous :</p>
                <div className="sj-rulebook-choices">
                  <RuleChoice number="1" title="Jouer avec les cartes de jeu" tone="blue">
                    Piochez une carte cachée ou prenez la défausse, puis suivez les mêmes choix que dans le mode classique.
                  </RuleChoice>
                  <RuleChoice number="2" title="Utiliser une carte Action" tone="pink">
                    Jouez une Action disponible à la place de piocher. Vous pouvez aussi la défausser sans l’utiliser : votre tour prend alors fin.
                  </RuleChoice>
                </div>
              </RulebookSection>

              <RulebookSection title="Cartes Étoile" accent>
                <div className="sj-rulebook-star-rules">
                  <Card value={0} kind="star" faceUp size="pile" suppressRevealAnimation />
                  <ul>
                    <li>Une Étoile vaut <strong>0 point</strong>.</li>
                    <li>Quand vous en révélez ou placez une, choisissez une Action visible ou piochez-en une cachée.</li>
                    <li>L’Étoile agit comme un joker pour compléter une ligne ou une colonne de valeurs identiques.</li>
                    <li>Une colonne entière d’Étoiles vaut <strong>-10 points</strong> ; une ligne entière vaut <strong>-15 points</strong>.</li>
                  </ul>
                </div>
              </RulebookSection>

              <RulebookSection title="Cartes Action">
                <ul>
                  <li>Une Action gagnée ne peut être utilisée qu’à partir de votre prochain tour.</li>
                  <li>Les Actions ne peuvent plus être jouées ni défaussées pendant le dernier tour de la manche.</li>
                  <li>Chaque Action encore en main à la fin de la manche ajoute <strong>10 points</strong> à votre score.</li>
                </ul>
                <button type="button" className="sj-guide-cards-link" onClick={() => selectTab('cards')}>
                  Consulter les 9 effets <ChevronRight aria-hidden="true" size={18} />
                </button>
              </RulebookSection>

              <RulebookSection title="Skyjo et fin de manche">
                <p>En mode Action, vous pouvez retirer une <strong>colonne de 3 cartes</strong> ou une <strong>ligne de 4 cartes</strong> de même valeur. Les Étoiles peuvent compléter ces groupes.</p>
                <p>La fin de manche, le doublement éventuel et la fin de partie à 100 points suivent les mêmes règles que le mode classique.</p>
              </RulebookSection>
            </div>
          )}

          {activeTab === 'cards' && (
            <div
              id="game-guide-panel-cards"
              className="sj-guide-section"
              role="tabpanel"
              aria-labelledby="game-guide-tab-cards"
            >
              <p className="sj-guide-section-intro">Sélectionnez une carte de votre main au début de votre tour pour la jouer ou la défausser.</p>
              <div className="sj-guide-card-grid">
                {ACTION_GUIDE_CARDS.map((card) => (
                  <article key={card.type} className="sj-guide-action-card">
                    <ActionTile card={card} interactive={false} />
                    <p className="sj-guide-action-description">{card.description}</p>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="sj-guide-footer">
          <button type="button" className="sj-btn sj-btn-primary" onClick={onStartTutorial}>
            Lancer le mini-tutoriel
          </button>
        </footer>
      </section>
    </div>
  );
}

const TUTORIAL_COPY = {
  [TUTORIAL_PHASES.TAKE_DISCARD]: {
    kicker: 'Votre premier tour',
    title: 'Prenez le 3 visible de la défausse',
    description: 'Une carte prise dans la défausse doit obligatoirement être placée sur votre plateau.',
  },
  [TUTORIAL_PHASES.PLACE_DISCARD]: {
    kicker: 'Carte prise dans la défausse',
    title: 'Remplacez le 12 par le 3',
    description: 'Cliquez sur votre 12. Il rejoint la défausse et le 3 prend sa place.',
  },
  [TUTORIAL_PHASES.DRAW_DECK]: {
    kicker: 'Tour suivant',
    title: 'Essayez maintenant la pioche',
    description: 'Contrairement à la défausse, la pioche vous laisse regarder la carte avant de décider de la garder ou non.',
  },
  [TUTORIAL_PHASES.DISCARD_DRAWN]: {
    kicker: 'Après avoir pioché',
    title: 'Défaussez le 10',
    description: 'Le 10 augmenterait votre total. Cliquez sur la défausse pour le rejeter.',
  },
  [TUTORIAL_PHASES.REVEAL_AFTER_DISCARD]: {
    kicker: 'Révélation obligatoire',
    title: 'Retournez le dernier 3 de la colonne',
    description: 'Révélez la carte indiquée. Elle complète naturellement votre colonne de 3, qui sera alors retirée.',
  },
  [TUTORIAL_PHASES.DRAW_STAR]: {
    kicker: 'Mode Action · tour suivant',
    title: 'Piochez une carte Étoile',
    description: 'Le mode Action est enrichi de cartes Étoile. Cliquez sur la pioche pour en obtenir une dans cet exemple.',
  },
  [TUTORIAL_PHASES.PLACE_STAR]: {
    kicker: 'Carte Étoile piochée',
    title: 'Choisissez où placer l’Étoile',
    description: 'Une Étoile vaut 0 point. Placez-la : son arrivée déclenchera le choix d’une carte Action.',
  },
  [TUTORIAL_PHASES.CLAIM_ACTION]: {
    kicker: 'Marché Action',
    title: 'Choisissez « Piocher trois cartes »',
    description: 'Cliquez sur cette carte Action dans le marché. Elle sera jouable à partir d’un prochain tour.',
  },
  [TUTORIAL_PHASES.OPEN_ACTION_HAND]: {
    kicker: 'Un tour plus tard',
    title: 'Ouvrez votre main de cartes Action',
    description: 'Votre carte Action est maintenant jouable depuis l’onglet rose au bord droit de la table.',
  },
  [TUTORIAL_PHASES.PLAY_ACTION]: {
    kicker: 'Votre main Action',
    title: 'Jouez votre carte Action',
    description: 'Cliquez sur la carte de votre main. Jouer une Action remplace votre pioche normale pour ce tour.',
  },
  [TUTORIAL_PHASES.CHOOSE_ACTION_CARD]: {
    kicker: 'Effet de l’Action',
    title: 'Choisissez une des trois cartes',
    description: 'Sélectionnez la carte que vous souhaitez conserver. Les deux autres seront défaussées.',
  },
  [TUTORIAL_PHASES.COMPLETE]: {
    kicker: 'Entraînement terminé',
    title: 'Vous êtes prêt à jouer',
    description: 'Ça y est, vous savez jouer ! Cherchez toujours le total le plus bas.',
  },
};

const TUTORIAL_MODAL_PHASES = new Set([
  TUTORIAL_PHASES.CLAIM_ACTION,
  TUTORIAL_PHASES.PLAY_ACTION,
  TUTORIAL_PHASES.CHOOSE_ACTION_CARD,
]);

function tutorialCopy(tutorial) {
  if (tutorial.phase === TUTORIAL_PHASES.PLACE_ACTION_CARD) {
    return {
      kicker: 'Dernier geste',
      title: `Placez le ${tutorial.selectedActionCard?.value} sur votre plateau`,
      description: 'Cliquez sur la carte de votre choix pour terminer l’effet de la carte Action.',
    };
  }
  if (tutorial.phase === TUTORIAL_PHASES.COMPLETE && tutorial.gameMode === 'action') {
    return {
      kicker: 'Entraînement terminé',
      title: 'Votre carte Action est résolue',
      description: `La carte ${tutorial.selectedActionCard?.value} a remplacé une carte cachée.`,
    };
  }
  if (tutorial.phase !== TUTORIAL_PHASES.REVEAL) return TUTORIAL_COPY[tutorial.phase];
  const remaining = 2 - tutorial.revealedCount;
  return {
    kicker: 'Mise en place réelle',
    title: remaining === 2 ? 'Retournez la première carte indiquée' : 'Retournez maintenant la seconde carte indiquée',
    description: 'Au début d’une vraie manche, vous choisissez librement deux cartes.',
  };
}

function TutorialDescription({ children }) {
  return <p>{children}</p>;
}

function TutorialProgress({ current, completed, total }) {
  const isFinished = completed === total;
  return (
    <div className="sj-tutorial-progress">
      <p className="sj-tutorial-progress-label">
        {isFinished ? 'Tutoriel terminé' : (
          <>Étape <strong>{current}</strong> / {total}{current === total ? ' · en cours' : ''}</>
        )}
      </p>
      <progress
        value={completed}
        max={total}
        aria-label={isFinished
          ? 'Tutoriel terminé'
          : `${completed} étape${completed === 1 ? '' : 's'} terminée${completed === 1 ? '' : 's'} sur ${total}, étape ${current} en cours`}
      />
    </div>
  );
}

function TutorialPiles({ tutorial, dispatch, locked = false }) {
  const canDraw = !locked && [TUTORIAL_PHASES.DRAW_DECK, TUTORIAL_PHASES.DRAW_STAR].includes(tutorial.phase);
  const canTakeDiscard = !locked && tutorial.phase === TUTORIAL_PHASES.TAKE_DISCARD;
  const canDiscardDrawn = !locked && tutorial.phase === TUTORIAL_PHASES.DISCARD_DRAWN;
  const discardEnabled = canTakeDiscard || canDiscardDrawn;

  return (
    <section className="sj-center sj-piles-zone sj-tutorial-pile-zone" aria-label="Pioches">
      <div className="sj-action-panel">
        <div className="sj-pile-group">
          <PileButton
            ariaLabel="Piocher dans le paquet"
            enabled={canDraw}
            active={canDraw}
            drawnCard={tutorial.drawnFrom === 'deck' ? tutorial.drawnCard : null}
            drawnFrom="deck"
            drawnPulse={tutorial.drawnFrom === 'deck'}
            onClick={() => dispatch({ type: TUTORIAL_EVENTS.DRAW_DECK })}
          >
            <Card faceUp={false} size="pile" pulse={canDraw} motionAnchor="pile:deck" />
          </PileButton>
          <PileButton
            ariaLabel={canDiscardDrawn ? 'Défausser la carte tirée' : 'Piocher dans la défausse'}
            enabled={discardEnabled}
            active={discardEnabled}
            tone={canDiscardDrawn ? 'danger' : 'default'}
            drawnCard={tutorial.drawnFrom === 'discard' ? tutorial.drawnCard : null}
            drawnFrom="discard"
            onClick={() => dispatch({
              type: canTakeDiscard ? TUTORIAL_EVENTS.DRAW_DISCARD : TUTORIAL_EVENTS.DISCARD_DRAWN,
            })}
          >
            <Card
              value={tutorial.discardTop.value}
              kind={tutorial.discardTop.kind}
              faceUp
              size="pile"
              pulse={discardEnabled}
              tone={canDiscardDrawn ? 'danger' : undefined}
              motionAnchor="pile:discard"
            />
          </PileButton>
        </div>
      </div>
    </section>
  );
}

function TutorialActionOverlay({ tutorial, dispatch }) {
  if (tutorial.phase === TUTORIAL_PHASES.CLAIM_ACTION) {
    const market = tutorial.actionChoices.map((type) => ({
      id: `tutorial-market-${type}`,
      type,
      unavailableReason: type === 'drawThree'
        ? undefined
        : 'Choisissez « Piocher trois cartes » pour continuer',
    }));
    return (
      <ActionDrawModal
        open
        market={market}
        canDrawDeck={false}
        showDeck
        deckUnavailableReason="Choisissez « Piocher trois cartes » pour continuer"
        titleId="tutorial-action-market-title"
        overlayClassName="sj-tutorial-action-overlay"
        onSelect={({ source, marketIndex }) => {
          if (source !== 'market') return;
          dispatch({
            type: TUTORIAL_EVENTS.CLAIM_ACTION,
            actionType: tutorial.actionChoices[marketIndex],
          });
        }}
      />
    );
  }

  if (tutorial.phase === TUTORIAL_PHASES.PLAY_ACTION) {
    return (
      <div className="sj-modal-overlay sj-tutorial-action-overlay sj-fade-in">
        <section className="sj-action-hand-modal sj-pop-in" role="dialog" aria-modal="true" aria-labelledby="tutorial-action-hand-title">
          <div className="sj-action-hand-modal-head">
            <h2 id="tutorial-action-hand-title">Cartes Action</h2>
            <button
              type="button"
              className="sj-action-hand-modal-close"
              aria-label="Fermer votre main de cartes Action"
              onClick={() => dispatch({ type: TUTORIAL_EVENTS.CLOSE_ACTION_HAND })}
            >
              ×
            </button>
          </div>
          <div className="sj-action-hand-modal-scroll">
            <div className="sj-action-hand-modal-grid sj-action-hand-modal-grid-1">
              <div className="sj-action-hand-modal-item sj-action-hand-modal-item-playable">
                <ActionTile
                  card={tutorial.actionCards[0]}
                  onClick={() => dispatch({ type: TUTORIAL_EVENTS.PLAY_ACTION, actionType: 'drawThree' })}
                />
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  if (tutorial.phase === TUTORIAL_PHASES.CHOOSE_ACTION_CARD) {
    return (
      <div className="sj-modal-overlay sj-tutorial-action-overlay sj-fade-in">
        <section className="sj-action-hand-modal sj-action-draw-three-modal sj-pop-in" role="dialog" aria-modal="true" aria-labelledby="tutorial-draw-three-title">
          <div className="sj-action-hand-modal-head">
            <h2 id="tutorial-draw-three-title">Piocher trois cartes</h2>
          </div>
          <div className="sj-action-draw-three-grid">
            {tutorial.actionChoices.map((card) => (
              <button
                key={card.id}
                type="button"
                className="sj-action-draw-three-choice"
                onClick={() => dispatch({ type: TUTORIAL_EVENTS.CHOOSE_ACTION_CARD, cardId: card.id })}
                aria-label={`Choisir la carte ${card.value}`}
              >
                <Card value={card.value} kind={card.kind} faceUp size="pile" />
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  }

  return null;
}

function tutorialBoardMode(phase) {
  if ([
    TUTORIAL_PHASES.REVEAL,
    TUTORIAL_PHASES.REVEAL_AFTER_DISCARD,
  ].includes(phase)) return 'reveal';
  if ([
    TUTORIAL_PHASES.PLACE_DISCARD,
    TUTORIAL_PHASES.PLACE_STAR,
    TUTORIAL_PHASES.PLACE_ACTION_CARD,
  ].includes(phase)) return 'place';
  return null;
}

function tutorialMotionState(tutorial, player) {
  return {
    roomId: `tutorial-room-${tutorial.resetSerial}`,
    roundNumber: 1,
    phase: 'playing',
    currentPlayerId: player.id,
    players: [player],
    drawnCard: tutorial.drawnCard ? {
      from: tutorial.drawnFrom,
      card: tutorial.drawnCard,
    } : null,
    discardTop: tutorial.discardTop,
    cardMoves: tutorial.cardMoves,
  };
}

export function GameTutorial({ open, gameMode, onClose, onFinish }) {
  const modalRef = useRef(null);
  const motionTimerRef = useRef(null);
  const completionTimerRef = useRef(null);
  const completionMotionEndsAtRef = useRef(0);
  const [tutorial, dispatch] = useReducer(tutorialGameReducer, gameMode, createTutorialGame);
  const [motionLocked, setMotionLocked] = useState(false);
  const [completionReady, setCompletionReady] = useState(false);
  const [dismissedOverlayPhase, setDismissedOverlayPhase] = useState(null);
  const copy = tutorialCopy(tutorial);
  const progress = tutorialProgress(tutorial);
  const isComplete = tutorial.phase === TUTORIAL_PHASES.COMPLETE;
  const showCompletion = isComplete && completionReady;
  const hasOpenTutorialModal = !motionLocked
    && TUTORIAL_MODAL_PHASES.has(tutorial.phase)
    && dismissedOverlayPhase !== tutorial.phase;
  const hasDismissedTutorialModal = dismissedOverlayPhase === tutorial.phase;
  const displayedStep = progress.current;
  const displayedCompleted = isComplete ? Math.max(0, progress.total - 1) : progress.completed;
  const player = {
    id: 'tutorial-player',
    name: 'Votre plateau',
    connected: true,
    totalScore: 0,
    lastRoundScore: null,
    board: tutorial.board,
  };
  const motionState = tutorialMotionState(tutorial, player);

  const lockInteractions = useCallback((duration) => {
    window.clearTimeout(motionTimerRef.current);
    setMotionLocked(true);
    motionTimerRef.current = window.setTimeout(() => {
      setMotionLocked(false);
      motionTimerRef.current = null;
    }, Math.max(0, duration));
  }, []);

  const handleMotionBatch = useCallback((endsAt) => {
    completionMotionEndsAtRef.current = Math.max(completionMotionEndsAtRef.current, endsAt);
    lockInteractions(endsAt - Date.now());
    if (!isComplete) return;
    window.clearTimeout(completionTimerRef.current);
    setCompletionReady(false);
    completionTimerRef.current = window.setTimeout(() => {
      completionTimerRef.current = null;
      setCompletionReady(true);
    }, Math.max(0, endsAt - Date.now()));
  }, [isComplete, lockInteractions]);

  const restartTutorial = useCallback(() => {
    window.clearTimeout(motionTimerRef.current);
    window.clearTimeout(completionTimerRef.current);
    motionTimerRef.current = null;
    completionTimerRef.current = null;
    completionMotionEndsAtRef.current = 0;
    setMotionLocked(false);
    setCompletionReady(false);
    setDismissedOverlayPhase(null);
    dispatch({ type: TUTORIAL_EVENTS.RESET, gameMode });
  }, [gameMode]);

  useEffect(() => {
    if (!open) return undefined;
    restartTutorial();
    modalRef.current?.focus({ preventScroll: true });
    return () => {
      window.clearTimeout(motionTimerRef.current);
      window.clearTimeout(completionTimerRef.current);
    };
  }, [open, restartTutorial]);

  useEffect(() => {
    if (!isComplete) return undefined;
    const frame = window.requestAnimationFrame(() => {
      window.clearTimeout(completionTimerRef.current);
      completionTimerRef.current = window.setTimeout(() => {
        completionTimerRef.current = null;
        setCompletionReady(true);
      }, Math.max(0, completionMotionEndsAtRef.current - Date.now()));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isComplete]);

  useEffect(() => {
    if (!showCompletion) return;
    modalRef.current?.focus({ preventScroll: true });
  }, [showCompletion]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation?.();
      if (hasOpenTutorialModal) {
        if (tutorial.phase === TUTORIAL_PHASES.PLAY_ACTION) {
          dispatch({ type: TUTORIAL_EVENTS.CLOSE_ACTION_HAND });
        } else {
          setDismissedOverlayPhase(tutorial.phase);
        }
        return;
      }
      onClose();
    };
    const handleDialogKeyDown = (event) => {
      if (event.key === 'Escape') {
        handleKeyDown(event);
        return;
      }
      keepFocusInDialog(event, modalRef.current);
    };
    window.addEventListener('keydown', handleDialogKeyDown);
    return () => window.removeEventListener('keydown', handleDialogKeyDown);
  }, [hasOpenTutorialModal, onClose, open, tutorial.phase]);

  useEffect(() => {
    if (!hasOpenTutorialModal) return undefined;
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelector('.sj-tutorial-action-overlay button:not([disabled])')
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [hasOpenTutorialModal, tutorial.phase]);

  if (!open) return null;

  const sendTutorialEvent = (event) => {
    if (motionLocked) return;
    if (event.type === TUTORIAL_EVENTS.DRAW_DECK) lockInteractions(440);
    if (event.type === TUTORIAL_EVENTS.DRAW_DISCARD) lockInteractions(260);
    if (event.type === TUTORIAL_EVENTS.REVEAL_SLOT) {
      lockInteractions(340);
    }
    dispatch(event);
  };

  const handleSlotClick = (slotIndex) => {
    if (motionLocked) return;
    const eventByPhase = {
      [TUTORIAL_PHASES.REVEAL]: TUTORIAL_EVENTS.REVEAL_SLOT,
      [TUTORIAL_PHASES.PLACE_DISCARD]: TUTORIAL_EVENTS.PLACE_DRAWN,
      [TUTORIAL_PHASES.REVEAL_AFTER_DISCARD]: TUTORIAL_EVENTS.REVEAL_SLOT,
      [TUTORIAL_PHASES.PLACE_STAR]: TUTORIAL_EVENTS.PLACE_DRAWN,
      [TUTORIAL_PHASES.PLACE_ACTION_CARD]: TUTORIAL_EVENTS.PLACE_ACTION_CARD,
    };
    const type = eventByPhase[tutorial.phase];
    if (type) sendTutorialEvent({ type, slotIndex });
  };

  return (
    <div className="sj-modal-overlay sj-tutorial-overlay sj-fade-in">
      {!showCompletion && (
        <>
          <CardMotionLayer
            key={tutorial.resetSerial}
            state={motionState}
            enabled
            anchorRootRef={modalRef}
            layerClassName="sj-card-motion-layer-tutorial"
            onMotionBatch={handleMotionBatch}
          />
          <section
            ref={modalRef}
            className="sj-tutorial-game sj-pop-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="game-tutorial-title"
            tabIndex={-1}
          >
            <header className="sj-tutorial-head">
              <div className="sj-tutorial-copy">
                <span>{copy.kicker}</span>
                <h2 id="game-tutorial-title">{copy.title}</h2>
                <TutorialDescription>{copy.description}</TutorialDescription>
              </div>
              <TutorialProgress
                current={displayedStep}
                completed={displayedCompleted}
                total={progress.total}
              />
            </header>
            <div className="sj-tutorial-head-actions">
              <button
                type="button"
                className="sj-tutorial-restart"
                onClick={restartTutorial}
                aria-label="Recommencer le tutoriel"
                title="Recommencer"
              >
                <RotateCcw aria-hidden="true" size={17} />
              </button>
              <button type="button" className="sj-tutorial-skip" onClick={onFinish}>Passer</button>
            </div>

            <div className="sj-tutorial-table">
              <div className="sj-tutorial-player">
                <PlayerBoard
                  player={player}
                  isMe
                  isActive
                  onSlotClick={handleSlotClick}
                  selectableSlots={motionLocked ? [] : tutorialSelectableSlots(tutorial)}
                  selectedSlots={[]}
                  actionMode={tutorialBoardMode(tutorial.phase)}
                />
              </div>
              <TutorialPiles tutorial={tutorial} dispatch={sendTutorialEvent} locked={motionLocked} />
              {hasDismissedTutorialModal && (
                <button
                  type="button"
                  className="sj-tutorial-resume-modal"
                  onClick={() => setDismissedOverlayPhase(null)}
                >
                  {tutorial.phase === TUTORIAL_PHASES.CLAIM_ACTION
                    ? 'Reprendre le choix de la carte Action'
                    : 'Reprendre le choix des trois cartes'}
                </button>
              )}
            </div>

            {!motionLocked && tutorial.phase === TUTORIAL_PHASES.OPEN_ACTION_HAND && (
              <ActionHandDock
                cards={tutorial.actionCards}
                onClick={() => sendTutorialEvent({ type: TUTORIAL_EVENTS.OPEN_ACTION_HAND })}
              />
            )}
          </section>
        </>
      )}
      {showCompletion && (
        <section
          ref={modalRef}
          className="sj-tutorial-completion sj-pop-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="game-tutorial-title"
          tabIndex={-1}
        >
          <div className="sj-tutorial-completion-icon" aria-hidden="true">
            <Check size={34} strokeWidth={3} />
          </div>
          <h2 id="game-tutorial-title">Tutoriel terminé</h2>
          <p>Vous connaissez maintenant les gestes essentiels pour commencer une partie.</p>
          <div className="sj-tutorial-completion-actions">
            <button type="button" className="sj-btn sj-tutorial-completion-restart" onClick={restartTutorial}>
              Recommencer
            </button>
            <button type="button" className="sj-btn sj-btn-primary sj-tutorial-completion-start" onClick={onFinish}>
              Jouer <ChevronRight aria-hidden="true" size={19} />
            </button>
          </div>
        </section>
      )}
      {hasOpenTutorialModal && (
        <TutorialActionOverlay tutorial={tutorial} dispatch={sendTutorialEvent} />
      )}
    </div>
  );
}

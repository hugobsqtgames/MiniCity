import { useEffect } from 'react';
import { BackHandler } from 'react-native';

import { useGameStore } from '../store/useGameStore';

/**
 * Bouton retour Android : ferme d'abord ce qui est ouvert (confirmation,
 * timelapse, défis, menu, fiche, outil) au lieu de quitter l'application.
 */
export function useBackButton() {
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const s = useGameStore.getState();
      if (s.confirm) s.closeConfirm();
      else if (s.timelapseOpen) s.openTimelapse(false);
      else if (s.challengesOpen) s.openChallenges(false);
      else if (s.menuTab !== null) s.openMenu(null);
      else if (s.citizen) s.showCitizen(null);
      else if (s.selected || s.tool !== 'inspect') s.setTool('inspect');
      else return false;
      return true;
    });
    return () => sub.remove();
  }, []);
}

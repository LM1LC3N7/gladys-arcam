// -----------------------------------------------------------------------------
// The texts users read in Gladys (configuration buttons, connection status),
// in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });
const list = (items) => items.join(', ');

export const T = {
  found: (lines) =>
    lines.length === 0
      ? both(
          'No Arcam device found. Type the IP address of each device in the configuration (the search cannot cross every network, and needs IP control on).',
          "Aucun appareil Arcam trouvé. Saisissez l'adresse IP de chaque appareil dans la configuration (la recherche ne traverse pas tous les réseaux, et demande le contrôle IP activé).",
        )
      : both(
          `Found: ${list(lines)}. Create them from the Discovery tab.`,
          `Trouvés : ${list(lines)}. Créez-les depuis l'onglet Découverte.`,
        ),
  noDevice: both(
    'No device known yet: type their IP addresses in the configuration, or use "Find the devices".',
    'Aucun appareil connu : saisissez leurs adresses IP dans la configuration, ou utilisez « Chercher les appareils ».',
  ),
  check: (lines, maxVolume) => ({
    en: [...lines.map((l) => l.en), `Volume cap: ${maxVolume}`].join(' · '),
    fr: [...lines.map((l) => l.fr), `Plafond de volume : ${maxVolume}`].join(' · '),
  }),
  checkLine: (label, state) => {
    if (state === null || state === undefined) {
      return both(
        `${label}: not connected (standby without network, off or unreachable)`,
        `${label} : non connecté (veille sans réseau, éteint ou injoignable)`,
      );
    }
    const en = [state.power === true ? 'on' : state.power === false ? 'standby' : 'power unknown'];
    const fr = [
      state.power === true ? 'allumé' : state.power === false ? 'en veille' : 'marche inconnue',
    ];
    if (Number.isInteger(state.volume)) {
      en.push(`volume ${state.volume}`);
      fr.push(`volume ${state.volume}`);
    }
    return both(`${label}: connected, ${en.join(', ')}`, `${label} : connecté, ${fr.join(', ')}`);
  },
  unreachable: (names) =>
    both(
      `Not connected (standby without network, off or unreachable), tried again at spaced intervals: ${list(names)}.`,
      `Non connectés (veille sans réseau, éteints ou injoignables), réessayés à intervalles espacés : ${list(names)}.`,
    ),
  noAnswerAt: (addresses) =>
    both(
      `No Arcam device answers yet at: ${list(addresses)}.`,
      `Aucun appareil Arcam ne répond encore à : ${list(addresses)}.`,
    ),
  invalidEntries: (entries) =>
    both(
      `Ignored in the configuration (invalid): ${list(entries)}.`,
      `Ignorés dans la configuration (invalides) : ${list(entries)}.`,
    ),
  dataReset: both(
    'The saved device list was unreadable and was reset; the devices are found again from their addresses.',
    'La liste enregistrée des appareils était illisible et a été réinitialisée ; les appareils sont retrouvés par leurs adresses.',
  ),
};

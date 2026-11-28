export interface PetdexMessagePreferences {
  petdexMessagesEnabled: boolean;
  petdexMessageDetailsEnabled: boolean;
}

export const DEFAULT_PETDEX_MESSAGE_PREFERENCES: Readonly<PetdexMessagePreferences> = {
  petdexMessagesEnabled: false,
  petdexMessageDetailsEnabled: false,
};

export function normalizePetdexMessagePreferences(value: unknown): PetdexMessagePreferences {
  const input = value && typeof value === 'object' ? value : {};
  return {
    petdexMessagesEnabled: 'petdexMessagesEnabled' in input && input.petdexMessagesEnabled === true,
    petdexMessageDetailsEnabled: 'petdexMessageDetailsEnabled' in input && input.petdexMessageDetailsEnabled === true,
  };
}

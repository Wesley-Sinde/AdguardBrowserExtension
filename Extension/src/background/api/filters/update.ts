/**
 * @file
 * This file is part of AdGuard Browser Extension (https://github.com/AdguardTeam/AdguardBrowserExtension).
 *
 * AdGuard Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * AdGuard Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with AdGuard Browser Extension. If not, see <http://www.gnu.org/licenses/>.
 */
import {
    filterStateStorage,
    filterVersionStorage,
    settingsStorage,
} from '../../storages';
import {
    SettingOption,
    RegularFilterMetadata,
    CustomFilterMetadata,
} from '../../schema';
import { DEFAULT_FILTERS_UPDATE_PERIOD } from '../../../common/settings';
import { Log } from '../../../common/log';

import { FilterMetadata, FiltersApi } from './main';
import { CustomFilterApi } from './custom';
import { CommonFilterApi } from './common';

/**
 * API for filter rules updates.
 */
export class FilterUpdateApi {
    /**
     * Checks enabled filters update.
     *
     * Called when user manually run update.
     */
    public static async updateEnabledFilters(): Promise<FilterMetadata[]> {
        const enabledFilters = FiltersApi.getEnabledFilters();

        const updatedFilters = await FilterUpdateApi.updateFilters(enabledFilters);

        filterVersionStorage.refreshLastCheckTime(enabledFilters);

        return updatedFilters;
    }

    /**
     * Checks installed filters update by matching update period via filters
     * version check and expires timestamps and also update metadata for all
     * installed filters.
     * Installed filters are filters whose rules are loaded in browser.storage.local.
     */
    public static async autoUpdateFilters(): Promise<void> {
        const updatePeriod = settingsStorage.get(SettingOption.FiltersUpdatePeriod);

        // auto update disabled
        if (updatePeriod === 0) {
            return;
        }

        const filtersVersions = filterVersionStorage.getData();

        const filtersStates = filterStateStorage.getData();

        const filterVersionEntries = Object.entries(filtersVersions);

        const installedFilterVersionEntries = filterVersionEntries
            .filter(([id]) => !!filtersStates?.[Number(id)]?.installed);

        const filtersIdsToUpdate = installedFilterVersionEntries
            // 'lastCheckTime' is a time of the last check by the sheduler
            // (every FilterUpdateService.CHECK_PERIOD_MS it is overwritten
            // by the sheduler or if the user presses check for updates from
            // the settings).
            // 'expires' is a data from filter metadata: after how long to check the update.
            .filter(([, { lastCheckTime, expires }]) => {
                // By default, check the expires field for each filter.
                if (updatePeriod === DEFAULT_FILTERS_UPDATE_PERIOD) {
                    // If it is time to check the update, add it to the array
                    return lastCheckTime + expires <= Date.now();
                }

                // Check, if the renewal period of each filter has passed.
                // If it is time to check the renewal, add to the array.
                return lastCheckTime + updatePeriod <= Date.now();
            })
            .map(([id]) => Number(id));

        await FilterUpdateApi.updateFilters(filtersIdsToUpdate);

        const installedFiltersIds = installedFilterVersionEntries.map(([id]) => Number(id));

        filterVersionStorage.refreshLastCheckTime(installedFiltersIds);
    }

    /**
     * Updates the content of filters for the provided list of identifiers and
     * updates the metadata of all filters.
     *
     * @param filtersIds List of filters ids to update.
     */
    public static async updateFilters(filtersIds: number[]): Promise<FilterMetadata[]> {
        /**
         * Reload common filters metadata from backend for correct
         * version matching on update check.
         */
        await FiltersApi.loadMetadata(true);

        const updatedFiltersMetadata: FilterMetadata[] = [];

        const updateTasks = filtersIds.map(async (filterId) => {
            let filterMetadata: CustomFilterMetadata | RegularFilterMetadata | null;

            if (CustomFilterApi.isCustomFilter(filterId)) {
                filterMetadata = await CustomFilterApi.updateFilter(filterId);
            } else {
                filterMetadata = await CommonFilterApi.updateFilter(filterId);
            }

            if (filterMetadata) {
                updatedFiltersMetadata.push(filterMetadata);
            }
        });

        const promises = await Promise.allSettled(updateTasks);

        // Handles errors
        promises.forEach((promise) => {
            if (promise.status === 'rejected') {
                Log.error('Cannot update filter due to: ', promise.reason);
            }
        });

        return updatedFiltersMetadata;
    }
}

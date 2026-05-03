'use strict';

const OPERATOR_DISPLAY_NAMES = new Map([
  ['CHARGE+ PTE. LTD.',                                              'Charge+'],
  ['EIGEN ENERGY PTE. LTD.',                                         'Eigen'],
  ['FASTPARKNCHARGE PTE. LTD.',                                      'FPNC'],
  ['MNL SOLUTIONS PTE. LTD.',                                        'MNL'],
  ['SHELL SINGAPORE PTE. LTD.',                                      'Shell'],
  ['SP MOBILITY PTE. LTD.',                                          'SP'],
  ['STRIDES YTL PTE. LTD.',                                         'Strides'],
  ['TESLA MOTORS SINGAPORE PRIVATE LIMITED',                         'Tesla'],
  ['TOTALENERGIES CHARGING SERVICES SINGAPORE PTE. LTD.',           'TotalEnergies'],
  ['VOLT SINGAPORE PTE. LTD.',                                       'Volt'],
]);

function operatorLabel(operator) {
  return OPERATOR_DISPLAY_NAMES.get(operator) || operator || 'Unknown';
}

module.exports = { operatorLabel };

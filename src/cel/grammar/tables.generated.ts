/**
 * GENERATED FILE — do not edit by hand.
 *
 * LALR(1) ACTION/GOTO tables for the CEL grammar, produced from
 * src/cel/grammar/grammar.ts by scripts/gen-cel-tables.ts. Regenerate with:
 *   npx tsx scripts/gen-cel-tables.ts
 *
 * Production indices match the PRODUCTIONS array in grammar.ts (and the reduce
 * actions in parser.ts). States: 95.
 */

import type { ParseTables } from './lalr.js';

export const TABLES: ParseTables = {
 "stateCount": 95,
 "action": [
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "$end": {
    "type": "accept"
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 0
   },
   ")": {
    "type": "reduce",
    "production": 0
   },
   "]": {
    "type": "reduce",
    "production": 0
   },
   ",": {
    "type": "reduce",
    "production": 0
   },
   ":": {
    "type": "reduce",
    "production": 0
   },
   "}": {
    "type": "reduce",
    "production": 0
   }
  },
  {
   "?": {
    "type": "shift",
    "state": 21
   },
   "||": {
    "type": "shift",
    "state": 22
   },
   "$end": {
    "type": "reduce",
    "production": 1
   },
   ")": {
    "type": "reduce",
    "production": 1
   },
   "]": {
    "type": "reduce",
    "production": 1
   },
   ",": {
    "type": "reduce",
    "production": 1
   },
   ":": {
    "type": "reduce",
    "production": 1
   },
   "}": {
    "type": "reduce",
    "production": 1
   }
  },
  {
   "&&": {
    "type": "shift",
    "state": 23
   },
   "$end": {
    "type": "reduce",
    "production": 4
   },
   "?": {
    "type": "reduce",
    "production": 4
   },
   "||": {
    "type": "reduce",
    "production": 4
   },
   ")": {
    "type": "reduce",
    "production": 4
   },
   "]": {
    "type": "reduce",
    "production": 4
   },
   ",": {
    "type": "reduce",
    "production": 4
   },
   ":": {
    "type": "reduce",
    "production": 4
   },
   "}": {
    "type": "reduce",
    "production": 4
   }
  },
  {
   "==": {
    "type": "shift",
    "state": 24
   },
   "!=": {
    "type": "shift",
    "state": 25
   },
   "<": {
    "type": "shift",
    "state": 26
   },
   "<=": {
    "type": "shift",
    "state": 27
   },
   ">": {
    "type": "shift",
    "state": 28
   },
   ">=": {
    "type": "shift",
    "state": 29
   },
   "in": {
    "type": "shift",
    "state": 30
   },
   "$end": {
    "type": "reduce",
    "production": 6
   },
   "?": {
    "type": "reduce",
    "production": 6
   },
   "||": {
    "type": "reduce",
    "production": 6
   },
   "&&": {
    "type": "reduce",
    "production": 6
   },
   ")": {
    "type": "reduce",
    "production": 6
   },
   "]": {
    "type": "reduce",
    "production": 6
   },
   ",": {
    "type": "reduce",
    "production": 6
   },
   ":": {
    "type": "reduce",
    "production": 6
   },
   "}": {
    "type": "reduce",
    "production": 6
   }
  },
  {
   "+": {
    "type": "shift",
    "state": 31
   },
   "-": {
    "type": "shift",
    "state": 32
   },
   "$end": {
    "type": "reduce",
    "production": 14
   },
   "?": {
    "type": "reduce",
    "production": 14
   },
   "||": {
    "type": "reduce",
    "production": 14
   },
   "&&": {
    "type": "reduce",
    "production": 14
   },
   "==": {
    "type": "reduce",
    "production": 14
   },
   "!=": {
    "type": "reduce",
    "production": 14
   },
   "<": {
    "type": "reduce",
    "production": 14
   },
   "<=": {
    "type": "reduce",
    "production": 14
   },
   ">": {
    "type": "reduce",
    "production": 14
   },
   ">=": {
    "type": "reduce",
    "production": 14
   },
   "in": {
    "type": "reduce",
    "production": 14
   },
   ")": {
    "type": "reduce",
    "production": 14
   },
   "]": {
    "type": "reduce",
    "production": 14
   },
   ",": {
    "type": "reduce",
    "production": 14
   },
   ":": {
    "type": "reduce",
    "production": 14
   },
   "}": {
    "type": "reduce",
    "production": 14
   }
  },
  {
   "*": {
    "type": "shift",
    "state": 33
   },
   "/": {
    "type": "shift",
    "state": 34
   },
   "%": {
    "type": "shift",
    "state": 35
   },
   "$end": {
    "type": "reduce",
    "production": 17
   },
   "?": {
    "type": "reduce",
    "production": 17
   },
   "||": {
    "type": "reduce",
    "production": 17
   },
   "&&": {
    "type": "reduce",
    "production": 17
   },
   "==": {
    "type": "reduce",
    "production": 17
   },
   "!=": {
    "type": "reduce",
    "production": 17
   },
   "<": {
    "type": "reduce",
    "production": 17
   },
   "<=": {
    "type": "reduce",
    "production": 17
   },
   ">": {
    "type": "reduce",
    "production": 17
   },
   ">=": {
    "type": "reduce",
    "production": 17
   },
   "in": {
    "type": "reduce",
    "production": 17
   },
   "+": {
    "type": "reduce",
    "production": 17
   },
   "-": {
    "type": "reduce",
    "production": 17
   },
   ")": {
    "type": "reduce",
    "production": 17
   },
   "]": {
    "type": "reduce",
    "production": 17
   },
   ",": {
    "type": "reduce",
    "production": 17
   },
   ":": {
    "type": "reduce",
    "production": 17
   },
   "}": {
    "type": "reduce",
    "production": 17
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 21
   },
   "?": {
    "type": "reduce",
    "production": 21
   },
   "||": {
    "type": "reduce",
    "production": 21
   },
   "&&": {
    "type": "reduce",
    "production": 21
   },
   "==": {
    "type": "reduce",
    "production": 21
   },
   "!=": {
    "type": "reduce",
    "production": 21
   },
   "<": {
    "type": "reduce",
    "production": 21
   },
   "<=": {
    "type": "reduce",
    "production": 21
   },
   ">": {
    "type": "reduce",
    "production": 21
   },
   ">=": {
    "type": "reduce",
    "production": 21
   },
   "in": {
    "type": "reduce",
    "production": 21
   },
   "+": {
    "type": "reduce",
    "production": 21
   },
   "-": {
    "type": "reduce",
    "production": 21
   },
   "*": {
    "type": "reduce",
    "production": 21
   },
   "/": {
    "type": "reduce",
    "production": 21
   },
   "%": {
    "type": "reduce",
    "production": 21
   },
   ")": {
    "type": "reduce",
    "production": 21
   },
   "]": {
    "type": "reduce",
    "production": 21
   },
   ",": {
    "type": "reduce",
    "production": 21
   },
   ":": {
    "type": "reduce",
    "production": 21
   },
   "}": {
    "type": "reduce",
    "production": 21
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   ".": {
    "type": "shift",
    "state": 38
   },
   "?.": {
    "type": "shift",
    "state": 39
   },
   "[": {
    "type": "shift",
    "state": 40
   },
   "?[": {
    "type": "shift",
    "state": 41
   },
   "$end": {
    "type": "reduce",
    "production": 24
   },
   "?": {
    "type": "reduce",
    "production": 24
   },
   "||": {
    "type": "reduce",
    "production": 24
   },
   "&&": {
    "type": "reduce",
    "production": 24
   },
   "==": {
    "type": "reduce",
    "production": 24
   },
   "!=": {
    "type": "reduce",
    "production": 24
   },
   "<": {
    "type": "reduce",
    "production": 24
   },
   "<=": {
    "type": "reduce",
    "production": 24
   },
   ">": {
    "type": "reduce",
    "production": 24
   },
   ">=": {
    "type": "reduce",
    "production": 24
   },
   "in": {
    "type": "reduce",
    "production": 24
   },
   "+": {
    "type": "reduce",
    "production": 24
   },
   "-": {
    "type": "reduce",
    "production": 24
   },
   "*": {
    "type": "reduce",
    "production": 24
   },
   "/": {
    "type": "reduce",
    "production": 24
   },
   "%": {
    "type": "reduce",
    "production": 24
   },
   ")": {
    "type": "reduce",
    "production": 24
   },
   "]": {
    "type": "reduce",
    "production": 24
   },
   ",": {
    "type": "reduce",
    "production": 24
   },
   ":": {
    "type": "reduce",
    "production": 24
   },
   "}": {
    "type": "reduce",
    "production": 24
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 25
   },
   "?": {
    "type": "reduce",
    "production": 25
   },
   "||": {
    "type": "reduce",
    "production": 25
   },
   "&&": {
    "type": "reduce",
    "production": 25
   },
   "==": {
    "type": "reduce",
    "production": 25
   },
   "!=": {
    "type": "reduce",
    "production": 25
   },
   "<": {
    "type": "reduce",
    "production": 25
   },
   "<=": {
    "type": "reduce",
    "production": 25
   },
   ">": {
    "type": "reduce",
    "production": 25
   },
   ">=": {
    "type": "reduce",
    "production": 25
   },
   "in": {
    "type": "reduce",
    "production": 25
   },
   "+": {
    "type": "reduce",
    "production": 25
   },
   "-": {
    "type": "reduce",
    "production": 25
   },
   "*": {
    "type": "reduce",
    "production": 25
   },
   "/": {
    "type": "reduce",
    "production": 25
   },
   "%": {
    "type": "reduce",
    "production": 25
   },
   ".": {
    "type": "reduce",
    "production": 25
   },
   "?.": {
    "type": "reduce",
    "production": 25
   },
   "[": {
    "type": "reduce",
    "production": 25
   },
   "?[": {
    "type": "reduce",
    "production": 25
   },
   ")": {
    "type": "reduce",
    "production": 25
   },
   "]": {
    "type": "reduce",
    "production": 25
   },
   ",": {
    "type": "reduce",
    "production": 25
   },
   ":": {
    "type": "reduce",
    "production": 25
   },
   "}": {
    "type": "reduce",
    "production": 25
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 32
   },
   "?": {
    "type": "reduce",
    "production": 32
   },
   "||": {
    "type": "reduce",
    "production": 32
   },
   "&&": {
    "type": "reduce",
    "production": 32
   },
   "==": {
    "type": "reduce",
    "production": 32
   },
   "!=": {
    "type": "reduce",
    "production": 32
   },
   "<": {
    "type": "reduce",
    "production": 32
   },
   "<=": {
    "type": "reduce",
    "production": 32
   },
   ">": {
    "type": "reduce",
    "production": 32
   },
   ">=": {
    "type": "reduce",
    "production": 32
   },
   "in": {
    "type": "reduce",
    "production": 32
   },
   "+": {
    "type": "reduce",
    "production": 32
   },
   "-": {
    "type": "reduce",
    "production": 32
   },
   "*": {
    "type": "reduce",
    "production": 32
   },
   "/": {
    "type": "reduce",
    "production": 32
   },
   "%": {
    "type": "reduce",
    "production": 32
   },
   ".": {
    "type": "reduce",
    "production": 32
   },
   "?.": {
    "type": "reduce",
    "production": 32
   },
   "[": {
    "type": "reduce",
    "production": 32
   },
   "?[": {
    "type": "reduce",
    "production": 32
   },
   ")": {
    "type": "reduce",
    "production": 32
   },
   "]": {
    "type": "reduce",
    "production": 32
   },
   ",": {
    "type": "reduce",
    "production": 32
   },
   ":": {
    "type": "reduce",
    "production": 32
   },
   "}": {
    "type": "reduce",
    "production": 32
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 33
   },
   "?": {
    "type": "reduce",
    "production": 33
   },
   "||": {
    "type": "reduce",
    "production": 33
   },
   "&&": {
    "type": "reduce",
    "production": 33
   },
   "==": {
    "type": "reduce",
    "production": 33
   },
   "!=": {
    "type": "reduce",
    "production": 33
   },
   "<": {
    "type": "reduce",
    "production": 33
   },
   "<=": {
    "type": "reduce",
    "production": 33
   },
   ">": {
    "type": "reduce",
    "production": 33
   },
   ">=": {
    "type": "reduce",
    "production": 33
   },
   "in": {
    "type": "reduce",
    "production": 33
   },
   "+": {
    "type": "reduce",
    "production": 33
   },
   "-": {
    "type": "reduce",
    "production": 33
   },
   "*": {
    "type": "reduce",
    "production": 33
   },
   "/": {
    "type": "reduce",
    "production": 33
   },
   "%": {
    "type": "reduce",
    "production": 33
   },
   ".": {
    "type": "reduce",
    "production": 33
   },
   "?.": {
    "type": "reduce",
    "production": 33
   },
   "[": {
    "type": "reduce",
    "production": 33
   },
   "?[": {
    "type": "reduce",
    "production": 33
   },
   ")": {
    "type": "reduce",
    "production": 33
   },
   "]": {
    "type": "reduce",
    "production": 33
   },
   ",": {
    "type": "reduce",
    "production": 33
   },
   ":": {
    "type": "reduce",
    "production": 33
   },
   "}": {
    "type": "reduce",
    "production": 33
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 34
   },
   "?": {
    "type": "reduce",
    "production": 34
   },
   "||": {
    "type": "reduce",
    "production": 34
   },
   "&&": {
    "type": "reduce",
    "production": 34
   },
   "==": {
    "type": "reduce",
    "production": 34
   },
   "!=": {
    "type": "reduce",
    "production": 34
   },
   "<": {
    "type": "reduce",
    "production": 34
   },
   "<=": {
    "type": "reduce",
    "production": 34
   },
   ">": {
    "type": "reduce",
    "production": 34
   },
   ">=": {
    "type": "reduce",
    "production": 34
   },
   "in": {
    "type": "reduce",
    "production": 34
   },
   "+": {
    "type": "reduce",
    "production": 34
   },
   "-": {
    "type": "reduce",
    "production": 34
   },
   "*": {
    "type": "reduce",
    "production": 34
   },
   "/": {
    "type": "reduce",
    "production": 34
   },
   "%": {
    "type": "reduce",
    "production": 34
   },
   ".": {
    "type": "reduce",
    "production": 34
   },
   "?.": {
    "type": "reduce",
    "production": 34
   },
   "[": {
    "type": "reduce",
    "production": 34
   },
   "?[": {
    "type": "reduce",
    "production": 34
   },
   ")": {
    "type": "reduce",
    "production": 34
   },
   "]": {
    "type": "reduce",
    "production": 34
   },
   ",": {
    "type": "reduce",
    "production": 34
   },
   ":": {
    "type": "reduce",
    "production": 34
   },
   "}": {
    "type": "reduce",
    "production": 34
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 35
   },
   "?": {
    "type": "reduce",
    "production": 35
   },
   "||": {
    "type": "reduce",
    "production": 35
   },
   "&&": {
    "type": "reduce",
    "production": 35
   },
   "==": {
    "type": "reduce",
    "production": 35
   },
   "!=": {
    "type": "reduce",
    "production": 35
   },
   "<": {
    "type": "reduce",
    "production": 35
   },
   "<=": {
    "type": "reduce",
    "production": 35
   },
   ">": {
    "type": "reduce",
    "production": 35
   },
   ">=": {
    "type": "reduce",
    "production": 35
   },
   "in": {
    "type": "reduce",
    "production": 35
   },
   "+": {
    "type": "reduce",
    "production": 35
   },
   "-": {
    "type": "reduce",
    "production": 35
   },
   "*": {
    "type": "reduce",
    "production": 35
   },
   "/": {
    "type": "reduce",
    "production": 35
   },
   "%": {
    "type": "reduce",
    "production": 35
   },
   ".": {
    "type": "reduce",
    "production": 35
   },
   "?.": {
    "type": "reduce",
    "production": 35
   },
   "[": {
    "type": "reduce",
    "production": 35
   },
   "?[": {
    "type": "reduce",
    "production": 35
   },
   ")": {
    "type": "reduce",
    "production": 35
   },
   "]": {
    "type": "reduce",
    "production": 35
   },
   ",": {
    "type": "reduce",
    "production": 35
   },
   ":": {
    "type": "reduce",
    "production": 35
   },
   "}": {
    "type": "reduce",
    "production": 35
   }
  },
  {
   "(": {
    "type": "shift",
    "state": 42
   },
   "$end": {
    "type": "reduce",
    "production": 36
   },
   "?": {
    "type": "reduce",
    "production": 36
   },
   "||": {
    "type": "reduce",
    "production": 36
   },
   "&&": {
    "type": "reduce",
    "production": 36
   },
   "==": {
    "type": "reduce",
    "production": 36
   },
   "!=": {
    "type": "reduce",
    "production": 36
   },
   "<": {
    "type": "reduce",
    "production": 36
   },
   "<=": {
    "type": "reduce",
    "production": 36
   },
   ">": {
    "type": "reduce",
    "production": 36
   },
   ">=": {
    "type": "reduce",
    "production": 36
   },
   "in": {
    "type": "reduce",
    "production": 36
   },
   "+": {
    "type": "reduce",
    "production": 36
   },
   "-": {
    "type": "reduce",
    "production": 36
   },
   "*": {
    "type": "reduce",
    "production": 36
   },
   "/": {
    "type": "reduce",
    "production": 36
   },
   "%": {
    "type": "reduce",
    "production": 36
   },
   ".": {
    "type": "reduce",
    "production": 36
   },
   "?.": {
    "type": "reduce",
    "production": 36
   },
   "[": {
    "type": "reduce",
    "production": 36
   },
   "?[": {
    "type": "reduce",
    "production": 36
   },
   ")": {
    "type": "reduce",
    "production": 36
   },
   "]": {
    "type": "reduce",
    "production": 36
   },
   ",": {
    "type": "reduce",
    "production": 36
   },
   ":": {
    "type": "reduce",
    "production": 36
   },
   "}": {
    "type": "reduce",
    "production": 36
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   },
   "]": {
    "type": "reduce",
    "production": 46
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   },
   "}": {
    "type": "reduce",
    "production": 51
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 22
   },
   "?": {
    "type": "reduce",
    "production": 22
   },
   "||": {
    "type": "reduce",
    "production": 22
   },
   "&&": {
    "type": "reduce",
    "production": 22
   },
   "==": {
    "type": "reduce",
    "production": 22
   },
   "!=": {
    "type": "reduce",
    "production": 22
   },
   "<": {
    "type": "reduce",
    "production": 22
   },
   "<=": {
    "type": "reduce",
    "production": 22
   },
   ">": {
    "type": "reduce",
    "production": 22
   },
   ">=": {
    "type": "reduce",
    "production": 22
   },
   "in": {
    "type": "reduce",
    "production": 22
   },
   "+": {
    "type": "reduce",
    "production": 22
   },
   "-": {
    "type": "reduce",
    "production": 22
   },
   "*": {
    "type": "reduce",
    "production": 22
   },
   "/": {
    "type": "reduce",
    "production": 22
   },
   "%": {
    "type": "reduce",
    "production": 22
   },
   ")": {
    "type": "reduce",
    "production": 22
   },
   "]": {
    "type": "reduce",
    "production": 22
   },
   ",": {
    "type": "reduce",
    "production": 22
   },
   ":": {
    "type": "reduce",
    "production": 22
   },
   "}": {
    "type": "reduce",
    "production": 22
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 23
   },
   "?": {
    "type": "reduce",
    "production": 23
   },
   "||": {
    "type": "reduce",
    "production": 23
   },
   "&&": {
    "type": "reduce",
    "production": 23
   },
   "==": {
    "type": "reduce",
    "production": 23
   },
   "!=": {
    "type": "reduce",
    "production": 23
   },
   "<": {
    "type": "reduce",
    "production": 23
   },
   "<=": {
    "type": "reduce",
    "production": 23
   },
   ">": {
    "type": "reduce",
    "production": 23
   },
   ">=": {
    "type": "reduce",
    "production": 23
   },
   "in": {
    "type": "reduce",
    "production": 23
   },
   "+": {
    "type": "reduce",
    "production": 23
   },
   "-": {
    "type": "reduce",
    "production": 23
   },
   "*": {
    "type": "reduce",
    "production": 23
   },
   "/": {
    "type": "reduce",
    "production": 23
   },
   "%": {
    "type": "reduce",
    "production": 23
   },
   ")": {
    "type": "reduce",
    "production": 23
   },
   "]": {
    "type": "reduce",
    "production": 23
   },
   ",": {
    "type": "reduce",
    "production": 23
   },
   ":": {
    "type": "reduce",
    "production": 23
   },
   "}": {
    "type": "reduce",
    "production": 23
   }
  },
  {
   "IDENT": {
    "type": "shift",
    "state": 66
   }
  },
  {
   "IDENT": {
    "type": "shift",
    "state": 67
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   },
   ")": {
    "type": "reduce",
    "production": 41
   }
  },
  {
   ")": {
    "type": "shift",
    "state": 73
   }
  },
  {
   "]": {
    "type": "shift",
    "state": 74
   }
  },
  {
   ",": {
    "type": "shift",
    "state": 75
   },
   "]": {
    "type": "reduce",
    "production": 47
   }
  },
  {
   "]": {
    "type": "reduce",
    "production": 49
   },
   ",": {
    "type": "reduce",
    "production": 49
   }
  },
  {
   "}": {
    "type": "shift",
    "state": 76
   }
  },
  {
   ",": {
    "type": "shift",
    "state": 77
   },
   "}": {
    "type": "reduce",
    "production": 52
   }
  },
  {
   "}": {
    "type": "reduce",
    "production": 54
   },
   ",": {
    "type": "reduce",
    "production": 54
   }
  },
  {
   ":": {
    "type": "shift",
    "state": 78
   }
  },
  {
   ":": {
    "type": "shift",
    "state": 79
   }
  },
  {
   "||": {
    "type": "reduce",
    "production": 3
   },
   "$end": {
    "type": "reduce",
    "production": 3
   },
   "?": {
    "type": "reduce",
    "production": 3
   },
   ")": {
    "type": "reduce",
    "production": 3
   },
   "]": {
    "type": "reduce",
    "production": 3
   },
   ",": {
    "type": "reduce",
    "production": 3
   },
   ":": {
    "type": "reduce",
    "production": 3
   },
   "}": {
    "type": "reduce",
    "production": 3
   }
  },
  {
   "&&": {
    "type": "reduce",
    "production": 5
   },
   "$end": {
    "type": "reduce",
    "production": 5
   },
   "?": {
    "type": "reduce",
    "production": 5
   },
   "||": {
    "type": "reduce",
    "production": 5
   },
   ")": {
    "type": "reduce",
    "production": 5
   },
   "]": {
    "type": "reduce",
    "production": 5
   },
   ",": {
    "type": "reduce",
    "production": 5
   },
   ":": {
    "type": "reduce",
    "production": 5
   },
   "}": {
    "type": "reduce",
    "production": 5
   }
  },
  {
   "==": {
    "type": "reduce",
    "production": 7
   },
   "!=": {
    "type": "reduce",
    "production": 7
   },
   "<": {
    "type": "reduce",
    "production": 7
   },
   "<=": {
    "type": "reduce",
    "production": 7
   },
   ">": {
    "type": "reduce",
    "production": 7
   },
   ">=": {
    "type": "reduce",
    "production": 7
   },
   "in": {
    "type": "reduce",
    "production": 7
   },
   "$end": {
    "type": "reduce",
    "production": 7
   },
   "?": {
    "type": "reduce",
    "production": 7
   },
   "||": {
    "type": "reduce",
    "production": 7
   },
   "&&": {
    "type": "reduce",
    "production": 7
   },
   ")": {
    "type": "reduce",
    "production": 7
   },
   "]": {
    "type": "reduce",
    "production": 7
   },
   ",": {
    "type": "reduce",
    "production": 7
   },
   ":": {
    "type": "reduce",
    "production": 7
   },
   "}": {
    "type": "reduce",
    "production": 7
   }
  },
  {
   "==": {
    "type": "reduce",
    "production": 8
   },
   "!=": {
    "type": "reduce",
    "production": 8
   },
   "<": {
    "type": "reduce",
    "production": 8
   },
   "<=": {
    "type": "reduce",
    "production": 8
   },
   ">": {
    "type": "reduce",
    "production": 8
   },
   ">=": {
    "type": "reduce",
    "production": 8
   },
   "in": {
    "type": "reduce",
    "production": 8
   },
   "$end": {
    "type": "reduce",
    "production": 8
   },
   "?": {
    "type": "reduce",
    "production": 8
   },
   "||": {
    "type": "reduce",
    "production": 8
   },
   "&&": {
    "type": "reduce",
    "production": 8
   },
   ")": {
    "type": "reduce",
    "production": 8
   },
   "]": {
    "type": "reduce",
    "production": 8
   },
   ",": {
    "type": "reduce",
    "production": 8
   },
   ":": {
    "type": "reduce",
    "production": 8
   },
   "}": {
    "type": "reduce",
    "production": 8
   }
  },
  {
   "==": {
    "type": "reduce",
    "production": 9
   },
   "!=": {
    "type": "reduce",
    "production": 9
   },
   "<": {
    "type": "reduce",
    "production": 9
   },
   "<=": {
    "type": "reduce",
    "production": 9
   },
   ">": {
    "type": "reduce",
    "production": 9
   },
   ">=": {
    "type": "reduce",
    "production": 9
   },
   "in": {
    "type": "reduce",
    "production": 9
   },
   "$end": {
    "type": "reduce",
    "production": 9
   },
   "?": {
    "type": "reduce",
    "production": 9
   },
   "||": {
    "type": "reduce",
    "production": 9
   },
   "&&": {
    "type": "reduce",
    "production": 9
   },
   ")": {
    "type": "reduce",
    "production": 9
   },
   "]": {
    "type": "reduce",
    "production": 9
   },
   ",": {
    "type": "reduce",
    "production": 9
   },
   ":": {
    "type": "reduce",
    "production": 9
   },
   "}": {
    "type": "reduce",
    "production": 9
   }
  },
  {
   "==": {
    "type": "reduce",
    "production": 10
   },
   "!=": {
    "type": "reduce",
    "production": 10
   },
   "<": {
    "type": "reduce",
    "production": 10
   },
   "<=": {
    "type": "reduce",
    "production": 10
   },
   ">": {
    "type": "reduce",
    "production": 10
   },
   ">=": {
    "type": "reduce",
    "production": 10
   },
   "in": {
    "type": "reduce",
    "production": 10
   },
   "$end": {
    "type": "reduce",
    "production": 10
   },
   "?": {
    "type": "reduce",
    "production": 10
   },
   "||": {
    "type": "reduce",
    "production": 10
   },
   "&&": {
    "type": "reduce",
    "production": 10
   },
   ")": {
    "type": "reduce",
    "production": 10
   },
   "]": {
    "type": "reduce",
    "production": 10
   },
   ",": {
    "type": "reduce",
    "production": 10
   },
   ":": {
    "type": "reduce",
    "production": 10
   },
   "}": {
    "type": "reduce",
    "production": 10
   }
  },
  {
   "==": {
    "type": "reduce",
    "production": 11
   },
   "!=": {
    "type": "reduce",
    "production": 11
   },
   "<": {
    "type": "reduce",
    "production": 11
   },
   "<=": {
    "type": "reduce",
    "production": 11
   },
   ">": {
    "type": "reduce",
    "production": 11
   },
   ">=": {
    "type": "reduce",
    "production": 11
   },
   "in": {
    "type": "reduce",
    "production": 11
   },
   "$end": {
    "type": "reduce",
    "production": 11
   },
   "?": {
    "type": "reduce",
    "production": 11
   },
   "||": {
    "type": "reduce",
    "production": 11
   },
   "&&": {
    "type": "reduce",
    "production": 11
   },
   ")": {
    "type": "reduce",
    "production": 11
   },
   "]": {
    "type": "reduce",
    "production": 11
   },
   ",": {
    "type": "reduce",
    "production": 11
   },
   ":": {
    "type": "reduce",
    "production": 11
   },
   "}": {
    "type": "reduce",
    "production": 11
   }
  },
  {
   "==": {
    "type": "reduce",
    "production": 12
   },
   "!=": {
    "type": "reduce",
    "production": 12
   },
   "<": {
    "type": "reduce",
    "production": 12
   },
   "<=": {
    "type": "reduce",
    "production": 12
   },
   ">": {
    "type": "reduce",
    "production": 12
   },
   ">=": {
    "type": "reduce",
    "production": 12
   },
   "in": {
    "type": "reduce",
    "production": 12
   },
   "$end": {
    "type": "reduce",
    "production": 12
   },
   "?": {
    "type": "reduce",
    "production": 12
   },
   "||": {
    "type": "reduce",
    "production": 12
   },
   "&&": {
    "type": "reduce",
    "production": 12
   },
   ")": {
    "type": "reduce",
    "production": 12
   },
   "]": {
    "type": "reduce",
    "production": 12
   },
   ",": {
    "type": "reduce",
    "production": 12
   },
   ":": {
    "type": "reduce",
    "production": 12
   },
   "}": {
    "type": "reduce",
    "production": 12
   }
  },
  {
   "==": {
    "type": "reduce",
    "production": 13
   },
   "!=": {
    "type": "reduce",
    "production": 13
   },
   "<": {
    "type": "reduce",
    "production": 13
   },
   "<=": {
    "type": "reduce",
    "production": 13
   },
   ">": {
    "type": "reduce",
    "production": 13
   },
   ">=": {
    "type": "reduce",
    "production": 13
   },
   "in": {
    "type": "reduce",
    "production": 13
   },
   "$end": {
    "type": "reduce",
    "production": 13
   },
   "?": {
    "type": "reduce",
    "production": 13
   },
   "||": {
    "type": "reduce",
    "production": 13
   },
   "&&": {
    "type": "reduce",
    "production": 13
   },
   ")": {
    "type": "reduce",
    "production": 13
   },
   "]": {
    "type": "reduce",
    "production": 13
   },
   ",": {
    "type": "reduce",
    "production": 13
   },
   ":": {
    "type": "reduce",
    "production": 13
   },
   "}": {
    "type": "reduce",
    "production": 13
   }
  },
  {
   "+": {
    "type": "reduce",
    "production": 15
   },
   "-": {
    "type": "reduce",
    "production": 15
   },
   "$end": {
    "type": "reduce",
    "production": 15
   },
   "?": {
    "type": "reduce",
    "production": 15
   },
   "||": {
    "type": "reduce",
    "production": 15
   },
   "&&": {
    "type": "reduce",
    "production": 15
   },
   "==": {
    "type": "reduce",
    "production": 15
   },
   "!=": {
    "type": "reduce",
    "production": 15
   },
   "<": {
    "type": "reduce",
    "production": 15
   },
   "<=": {
    "type": "reduce",
    "production": 15
   },
   ">": {
    "type": "reduce",
    "production": 15
   },
   ">=": {
    "type": "reduce",
    "production": 15
   },
   "in": {
    "type": "reduce",
    "production": 15
   },
   ")": {
    "type": "reduce",
    "production": 15
   },
   "]": {
    "type": "reduce",
    "production": 15
   },
   ",": {
    "type": "reduce",
    "production": 15
   },
   ":": {
    "type": "reduce",
    "production": 15
   },
   "}": {
    "type": "reduce",
    "production": 15
   }
  },
  {
   "+": {
    "type": "reduce",
    "production": 16
   },
   "-": {
    "type": "reduce",
    "production": 16
   },
   "$end": {
    "type": "reduce",
    "production": 16
   },
   "?": {
    "type": "reduce",
    "production": 16
   },
   "||": {
    "type": "reduce",
    "production": 16
   },
   "&&": {
    "type": "reduce",
    "production": 16
   },
   "==": {
    "type": "reduce",
    "production": 16
   },
   "!=": {
    "type": "reduce",
    "production": 16
   },
   "<": {
    "type": "reduce",
    "production": 16
   },
   "<=": {
    "type": "reduce",
    "production": 16
   },
   ">": {
    "type": "reduce",
    "production": 16
   },
   ">=": {
    "type": "reduce",
    "production": 16
   },
   "in": {
    "type": "reduce",
    "production": 16
   },
   ")": {
    "type": "reduce",
    "production": 16
   },
   "]": {
    "type": "reduce",
    "production": 16
   },
   ",": {
    "type": "reduce",
    "production": 16
   },
   ":": {
    "type": "reduce",
    "production": 16
   },
   "}": {
    "type": "reduce",
    "production": 16
   }
  },
  {
   "*": {
    "type": "reduce",
    "production": 18
   },
   "/": {
    "type": "reduce",
    "production": 18
   },
   "%": {
    "type": "reduce",
    "production": 18
   },
   "$end": {
    "type": "reduce",
    "production": 18
   },
   "?": {
    "type": "reduce",
    "production": 18
   },
   "||": {
    "type": "reduce",
    "production": 18
   },
   "&&": {
    "type": "reduce",
    "production": 18
   },
   "==": {
    "type": "reduce",
    "production": 18
   },
   "!=": {
    "type": "reduce",
    "production": 18
   },
   "<": {
    "type": "reduce",
    "production": 18
   },
   "<=": {
    "type": "reduce",
    "production": 18
   },
   ">": {
    "type": "reduce",
    "production": 18
   },
   ">=": {
    "type": "reduce",
    "production": 18
   },
   "in": {
    "type": "reduce",
    "production": 18
   },
   "+": {
    "type": "reduce",
    "production": 18
   },
   "-": {
    "type": "reduce",
    "production": 18
   },
   ")": {
    "type": "reduce",
    "production": 18
   },
   "]": {
    "type": "reduce",
    "production": 18
   },
   ",": {
    "type": "reduce",
    "production": 18
   },
   ":": {
    "type": "reduce",
    "production": 18
   },
   "}": {
    "type": "reduce",
    "production": 18
   }
  },
  {
   "*": {
    "type": "reduce",
    "production": 19
   },
   "/": {
    "type": "reduce",
    "production": 19
   },
   "%": {
    "type": "reduce",
    "production": 19
   },
   "$end": {
    "type": "reduce",
    "production": 19
   },
   "?": {
    "type": "reduce",
    "production": 19
   },
   "||": {
    "type": "reduce",
    "production": 19
   },
   "&&": {
    "type": "reduce",
    "production": 19
   },
   "==": {
    "type": "reduce",
    "production": 19
   },
   "!=": {
    "type": "reduce",
    "production": 19
   },
   "<": {
    "type": "reduce",
    "production": 19
   },
   "<=": {
    "type": "reduce",
    "production": 19
   },
   ">": {
    "type": "reduce",
    "production": 19
   },
   ">=": {
    "type": "reduce",
    "production": 19
   },
   "in": {
    "type": "reduce",
    "production": 19
   },
   "+": {
    "type": "reduce",
    "production": 19
   },
   "-": {
    "type": "reduce",
    "production": 19
   },
   ")": {
    "type": "reduce",
    "production": 19
   },
   "]": {
    "type": "reduce",
    "production": 19
   },
   ",": {
    "type": "reduce",
    "production": 19
   },
   ":": {
    "type": "reduce",
    "production": 19
   },
   "}": {
    "type": "reduce",
    "production": 19
   }
  },
  {
   "*": {
    "type": "reduce",
    "production": 20
   },
   "/": {
    "type": "reduce",
    "production": 20
   },
   "%": {
    "type": "reduce",
    "production": 20
   },
   "$end": {
    "type": "reduce",
    "production": 20
   },
   "?": {
    "type": "reduce",
    "production": 20
   },
   "||": {
    "type": "reduce",
    "production": 20
   },
   "&&": {
    "type": "reduce",
    "production": 20
   },
   "==": {
    "type": "reduce",
    "production": 20
   },
   "!=": {
    "type": "reduce",
    "production": 20
   },
   "<": {
    "type": "reduce",
    "production": 20
   },
   "<=": {
    "type": "reduce",
    "production": 20
   },
   ">": {
    "type": "reduce",
    "production": 20
   },
   ">=": {
    "type": "reduce",
    "production": 20
   },
   "in": {
    "type": "reduce",
    "production": 20
   },
   "+": {
    "type": "reduce",
    "production": 20
   },
   "-": {
    "type": "reduce",
    "production": 20
   },
   ")": {
    "type": "reduce",
    "production": 20
   },
   "]": {
    "type": "reduce",
    "production": 20
   },
   ",": {
    "type": "reduce",
    "production": 20
   },
   ":": {
    "type": "reduce",
    "production": 20
   },
   "}": {
    "type": "reduce",
    "production": 20
   }
  },
  {
   "(": {
    "type": "shift",
    "state": 80
   },
   "$end": {
    "type": "reduce",
    "production": 26
   },
   "?": {
    "type": "reduce",
    "production": 26
   },
   "||": {
    "type": "reduce",
    "production": 26
   },
   "&&": {
    "type": "reduce",
    "production": 26
   },
   "==": {
    "type": "reduce",
    "production": 26
   },
   "!=": {
    "type": "reduce",
    "production": 26
   },
   "<": {
    "type": "reduce",
    "production": 26
   },
   "<=": {
    "type": "reduce",
    "production": 26
   },
   ">": {
    "type": "reduce",
    "production": 26
   },
   ">=": {
    "type": "reduce",
    "production": 26
   },
   "in": {
    "type": "reduce",
    "production": 26
   },
   "+": {
    "type": "reduce",
    "production": 26
   },
   "-": {
    "type": "reduce",
    "production": 26
   },
   "*": {
    "type": "reduce",
    "production": 26
   },
   "/": {
    "type": "reduce",
    "production": 26
   },
   "%": {
    "type": "reduce",
    "production": 26
   },
   ".": {
    "type": "reduce",
    "production": 26
   },
   "?.": {
    "type": "reduce",
    "production": 26
   },
   "[": {
    "type": "reduce",
    "production": 26
   },
   "?[": {
    "type": "reduce",
    "production": 26
   },
   ")": {
    "type": "reduce",
    "production": 26
   },
   "]": {
    "type": "reduce",
    "production": 26
   },
   ",": {
    "type": "reduce",
    "production": 26
   },
   ":": {
    "type": "reduce",
    "production": 26
   },
   "}": {
    "type": "reduce",
    "production": 26
   }
  },
  {
   "(": {
    "type": "shift",
    "state": 81
   },
   "$end": {
    "type": "reduce",
    "production": 28
   },
   "?": {
    "type": "reduce",
    "production": 28
   },
   "||": {
    "type": "reduce",
    "production": 28
   },
   "&&": {
    "type": "reduce",
    "production": 28
   },
   "==": {
    "type": "reduce",
    "production": 28
   },
   "!=": {
    "type": "reduce",
    "production": 28
   },
   "<": {
    "type": "reduce",
    "production": 28
   },
   "<=": {
    "type": "reduce",
    "production": 28
   },
   ">": {
    "type": "reduce",
    "production": 28
   },
   ">=": {
    "type": "reduce",
    "production": 28
   },
   "in": {
    "type": "reduce",
    "production": 28
   },
   "+": {
    "type": "reduce",
    "production": 28
   },
   "-": {
    "type": "reduce",
    "production": 28
   },
   "*": {
    "type": "reduce",
    "production": 28
   },
   "/": {
    "type": "reduce",
    "production": 28
   },
   "%": {
    "type": "reduce",
    "production": 28
   },
   ".": {
    "type": "reduce",
    "production": 28
   },
   "?.": {
    "type": "reduce",
    "production": 28
   },
   "[": {
    "type": "reduce",
    "production": 28
   },
   "?[": {
    "type": "reduce",
    "production": 28
   },
   ")": {
    "type": "reduce",
    "production": 28
   },
   "]": {
    "type": "reduce",
    "production": 28
   },
   ",": {
    "type": "reduce",
    "production": 28
   },
   ":": {
    "type": "reduce",
    "production": 28
   },
   "}": {
    "type": "reduce",
    "production": 28
   }
  },
  {
   "]": {
    "type": "shift",
    "state": 82
   }
  },
  {
   "]": {
    "type": "shift",
    "state": 83
   }
  },
  {
   ")": {
    "type": "shift",
    "state": 84
   }
  },
  {
   ",": {
    "type": "shift",
    "state": 85
   },
   ")": {
    "type": "reduce",
    "production": 42
   }
  },
  {
   ")": {
    "type": "reduce",
    "production": 44
   },
   ",": {
    "type": "reduce",
    "production": 44
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 38
   },
   "?": {
    "type": "reduce",
    "production": 38
   },
   "||": {
    "type": "reduce",
    "production": 38
   },
   "&&": {
    "type": "reduce",
    "production": 38
   },
   "==": {
    "type": "reduce",
    "production": 38
   },
   "!=": {
    "type": "reduce",
    "production": 38
   },
   "<": {
    "type": "reduce",
    "production": 38
   },
   "<=": {
    "type": "reduce",
    "production": 38
   },
   ">": {
    "type": "reduce",
    "production": 38
   },
   ">=": {
    "type": "reduce",
    "production": 38
   },
   "in": {
    "type": "reduce",
    "production": 38
   },
   "+": {
    "type": "reduce",
    "production": 38
   },
   "-": {
    "type": "reduce",
    "production": 38
   },
   "*": {
    "type": "reduce",
    "production": 38
   },
   "/": {
    "type": "reduce",
    "production": 38
   },
   "%": {
    "type": "reduce",
    "production": 38
   },
   ".": {
    "type": "reduce",
    "production": 38
   },
   "?.": {
    "type": "reduce",
    "production": 38
   },
   "[": {
    "type": "reduce",
    "production": 38
   },
   "?[": {
    "type": "reduce",
    "production": 38
   },
   ")": {
    "type": "reduce",
    "production": 38
   },
   "]": {
    "type": "reduce",
    "production": 38
   },
   ",": {
    "type": "reduce",
    "production": 38
   },
   ":": {
    "type": "reduce",
    "production": 38
   },
   "}": {
    "type": "reduce",
    "production": 38
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 39
   },
   "?": {
    "type": "reduce",
    "production": 39
   },
   "||": {
    "type": "reduce",
    "production": 39
   },
   "&&": {
    "type": "reduce",
    "production": 39
   },
   "==": {
    "type": "reduce",
    "production": 39
   },
   "!=": {
    "type": "reduce",
    "production": 39
   },
   "<": {
    "type": "reduce",
    "production": 39
   },
   "<=": {
    "type": "reduce",
    "production": 39
   },
   ">": {
    "type": "reduce",
    "production": 39
   },
   ">=": {
    "type": "reduce",
    "production": 39
   },
   "in": {
    "type": "reduce",
    "production": 39
   },
   "+": {
    "type": "reduce",
    "production": 39
   },
   "-": {
    "type": "reduce",
    "production": 39
   },
   "*": {
    "type": "reduce",
    "production": 39
   },
   "/": {
    "type": "reduce",
    "production": 39
   },
   "%": {
    "type": "reduce",
    "production": 39
   },
   ".": {
    "type": "reduce",
    "production": 39
   },
   "?.": {
    "type": "reduce",
    "production": 39
   },
   "[": {
    "type": "reduce",
    "production": 39
   },
   "?[": {
    "type": "reduce",
    "production": 39
   },
   ")": {
    "type": "reduce",
    "production": 39
   },
   "]": {
    "type": "reduce",
    "production": 39
   },
   ",": {
    "type": "reduce",
    "production": 39
   },
   ":": {
    "type": "reduce",
    "production": 39
   },
   "}": {
    "type": "reduce",
    "production": 39
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   },
   "]": {
    "type": "reduce",
    "production": 48
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 40
   },
   "?": {
    "type": "reduce",
    "production": 40
   },
   "||": {
    "type": "reduce",
    "production": 40
   },
   "&&": {
    "type": "reduce",
    "production": 40
   },
   "==": {
    "type": "reduce",
    "production": 40
   },
   "!=": {
    "type": "reduce",
    "production": 40
   },
   "<": {
    "type": "reduce",
    "production": 40
   },
   "<=": {
    "type": "reduce",
    "production": 40
   },
   ">": {
    "type": "reduce",
    "production": 40
   },
   ">=": {
    "type": "reduce",
    "production": 40
   },
   "in": {
    "type": "reduce",
    "production": 40
   },
   "+": {
    "type": "reduce",
    "production": 40
   },
   "-": {
    "type": "reduce",
    "production": 40
   },
   "*": {
    "type": "reduce",
    "production": 40
   },
   "/": {
    "type": "reduce",
    "production": 40
   },
   "%": {
    "type": "reduce",
    "production": 40
   },
   ".": {
    "type": "reduce",
    "production": 40
   },
   "?.": {
    "type": "reduce",
    "production": 40
   },
   "[": {
    "type": "reduce",
    "production": 40
   },
   "?[": {
    "type": "reduce",
    "production": 40
   },
   ")": {
    "type": "reduce",
    "production": 40
   },
   "]": {
    "type": "reduce",
    "production": 40
   },
   ",": {
    "type": "reduce",
    "production": 40
   },
   ":": {
    "type": "reduce",
    "production": 40
   },
   "}": {
    "type": "reduce",
    "production": 40
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   },
   "}": {
    "type": "reduce",
    "production": 53
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   },
   ")": {
    "type": "reduce",
    "production": 41
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   },
   ")": {
    "type": "reduce",
    "production": 41
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 30
   },
   "?": {
    "type": "reduce",
    "production": 30
   },
   "||": {
    "type": "reduce",
    "production": 30
   },
   "&&": {
    "type": "reduce",
    "production": 30
   },
   "==": {
    "type": "reduce",
    "production": 30
   },
   "!=": {
    "type": "reduce",
    "production": 30
   },
   "<": {
    "type": "reduce",
    "production": 30
   },
   "<=": {
    "type": "reduce",
    "production": 30
   },
   ">": {
    "type": "reduce",
    "production": 30
   },
   ">=": {
    "type": "reduce",
    "production": 30
   },
   "in": {
    "type": "reduce",
    "production": 30
   },
   "+": {
    "type": "reduce",
    "production": 30
   },
   "-": {
    "type": "reduce",
    "production": 30
   },
   "*": {
    "type": "reduce",
    "production": 30
   },
   "/": {
    "type": "reduce",
    "production": 30
   },
   "%": {
    "type": "reduce",
    "production": 30
   },
   ".": {
    "type": "reduce",
    "production": 30
   },
   "?.": {
    "type": "reduce",
    "production": 30
   },
   "[": {
    "type": "reduce",
    "production": 30
   },
   "?[": {
    "type": "reduce",
    "production": 30
   },
   ")": {
    "type": "reduce",
    "production": 30
   },
   "]": {
    "type": "reduce",
    "production": 30
   },
   ",": {
    "type": "reduce",
    "production": 30
   },
   ":": {
    "type": "reduce",
    "production": 30
   },
   "}": {
    "type": "reduce",
    "production": 30
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 31
   },
   "?": {
    "type": "reduce",
    "production": 31
   },
   "||": {
    "type": "reduce",
    "production": 31
   },
   "&&": {
    "type": "reduce",
    "production": 31
   },
   "==": {
    "type": "reduce",
    "production": 31
   },
   "!=": {
    "type": "reduce",
    "production": 31
   },
   "<": {
    "type": "reduce",
    "production": 31
   },
   "<=": {
    "type": "reduce",
    "production": 31
   },
   ">": {
    "type": "reduce",
    "production": 31
   },
   ">=": {
    "type": "reduce",
    "production": 31
   },
   "in": {
    "type": "reduce",
    "production": 31
   },
   "+": {
    "type": "reduce",
    "production": 31
   },
   "-": {
    "type": "reduce",
    "production": 31
   },
   "*": {
    "type": "reduce",
    "production": 31
   },
   "/": {
    "type": "reduce",
    "production": 31
   },
   "%": {
    "type": "reduce",
    "production": 31
   },
   ".": {
    "type": "reduce",
    "production": 31
   },
   "?.": {
    "type": "reduce",
    "production": 31
   },
   "[": {
    "type": "reduce",
    "production": 31
   },
   "?[": {
    "type": "reduce",
    "production": 31
   },
   ")": {
    "type": "reduce",
    "production": 31
   },
   "]": {
    "type": "reduce",
    "production": 31
   },
   ",": {
    "type": "reduce",
    "production": 31
   },
   ":": {
    "type": "reduce",
    "production": 31
   },
   "}": {
    "type": "reduce",
    "production": 31
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 37
   },
   "?": {
    "type": "reduce",
    "production": 37
   },
   "||": {
    "type": "reduce",
    "production": 37
   },
   "&&": {
    "type": "reduce",
    "production": 37
   },
   "==": {
    "type": "reduce",
    "production": 37
   },
   "!=": {
    "type": "reduce",
    "production": 37
   },
   "<": {
    "type": "reduce",
    "production": 37
   },
   "<=": {
    "type": "reduce",
    "production": 37
   },
   ">": {
    "type": "reduce",
    "production": 37
   },
   ">=": {
    "type": "reduce",
    "production": 37
   },
   "in": {
    "type": "reduce",
    "production": 37
   },
   "+": {
    "type": "reduce",
    "production": 37
   },
   "-": {
    "type": "reduce",
    "production": 37
   },
   "*": {
    "type": "reduce",
    "production": 37
   },
   "/": {
    "type": "reduce",
    "production": 37
   },
   "%": {
    "type": "reduce",
    "production": 37
   },
   ".": {
    "type": "reduce",
    "production": 37
   },
   "?.": {
    "type": "reduce",
    "production": 37
   },
   "[": {
    "type": "reduce",
    "production": 37
   },
   "?[": {
    "type": "reduce",
    "production": 37
   },
   ")": {
    "type": "reduce",
    "production": 37
   },
   "]": {
    "type": "reduce",
    "production": 37
   },
   ",": {
    "type": "reduce",
    "production": 37
   },
   ":": {
    "type": "reduce",
    "production": 37
   },
   "}": {
    "type": "reduce",
    "production": 37
   }
  },
  {
   "!": {
    "type": "shift",
    "state": 9
   },
   "-": {
    "type": "shift",
    "state": 10
   },
   "NUMBER": {
    "type": "shift",
    "state": 13
   },
   "STRING": {
    "type": "shift",
    "state": 14
   },
   "BOOL": {
    "type": "shift",
    "state": 15
   },
   "NULL": {
    "type": "shift",
    "state": 16
   },
   "IDENT": {
    "type": "shift",
    "state": 17
   },
   "(": {
    "type": "shift",
    "state": 18
   },
   "[": {
    "type": "shift",
    "state": 19
   },
   "{": {
    "type": "shift",
    "state": 20
   },
   ")": {
    "type": "reduce",
    "production": 43
   }
  },
  {
   "]": {
    "type": "reduce",
    "production": 50
   },
   ",": {
    "type": "reduce",
    "production": 50
   }
  },
  {
   "}": {
    "type": "reduce",
    "production": 55
   },
   ",": {
    "type": "reduce",
    "production": 55
   }
  },
  {
   "}": {
    "type": "reduce",
    "production": 56
   },
   ",": {
    "type": "reduce",
    "production": 56
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 2
   },
   ")": {
    "type": "reduce",
    "production": 2
   },
   "]": {
    "type": "reduce",
    "production": 2
   },
   ",": {
    "type": "reduce",
    "production": 2
   },
   ":": {
    "type": "reduce",
    "production": 2
   },
   "}": {
    "type": "reduce",
    "production": 2
   }
  },
  {
   ")": {
    "type": "shift",
    "state": 93
   }
  },
  {
   ")": {
    "type": "shift",
    "state": 94
   }
  },
  {
   ")": {
    "type": "reduce",
    "production": 45
   },
   ",": {
    "type": "reduce",
    "production": 45
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 27
   },
   "?": {
    "type": "reduce",
    "production": 27
   },
   "||": {
    "type": "reduce",
    "production": 27
   },
   "&&": {
    "type": "reduce",
    "production": 27
   },
   "==": {
    "type": "reduce",
    "production": 27
   },
   "!=": {
    "type": "reduce",
    "production": 27
   },
   "<": {
    "type": "reduce",
    "production": 27
   },
   "<=": {
    "type": "reduce",
    "production": 27
   },
   ">": {
    "type": "reduce",
    "production": 27
   },
   ">=": {
    "type": "reduce",
    "production": 27
   },
   "in": {
    "type": "reduce",
    "production": 27
   },
   "+": {
    "type": "reduce",
    "production": 27
   },
   "-": {
    "type": "reduce",
    "production": 27
   },
   "*": {
    "type": "reduce",
    "production": 27
   },
   "/": {
    "type": "reduce",
    "production": 27
   },
   "%": {
    "type": "reduce",
    "production": 27
   },
   ".": {
    "type": "reduce",
    "production": 27
   },
   "?.": {
    "type": "reduce",
    "production": 27
   },
   "[": {
    "type": "reduce",
    "production": 27
   },
   "?[": {
    "type": "reduce",
    "production": 27
   },
   ")": {
    "type": "reduce",
    "production": 27
   },
   "]": {
    "type": "reduce",
    "production": 27
   },
   ",": {
    "type": "reduce",
    "production": 27
   },
   ":": {
    "type": "reduce",
    "production": 27
   },
   "}": {
    "type": "reduce",
    "production": 27
   }
  },
  {
   "$end": {
    "type": "reduce",
    "production": 29
   },
   "?": {
    "type": "reduce",
    "production": 29
   },
   "||": {
    "type": "reduce",
    "production": 29
   },
   "&&": {
    "type": "reduce",
    "production": 29
   },
   "==": {
    "type": "reduce",
    "production": 29
   },
   "!=": {
    "type": "reduce",
    "production": 29
   },
   "<": {
    "type": "reduce",
    "production": 29
   },
   "<=": {
    "type": "reduce",
    "production": 29
   },
   ">": {
    "type": "reduce",
    "production": 29
   },
   ">=": {
    "type": "reduce",
    "production": 29
   },
   "in": {
    "type": "reduce",
    "production": 29
   },
   "+": {
    "type": "reduce",
    "production": 29
   },
   "-": {
    "type": "reduce",
    "production": 29
   },
   "*": {
    "type": "reduce",
    "production": 29
   },
   "/": {
    "type": "reduce",
    "production": 29
   },
   "%": {
    "type": "reduce",
    "production": 29
   },
   ".": {
    "type": "reduce",
    "production": 29
   },
   "?.": {
    "type": "reduce",
    "production": 29
   },
   "[": {
    "type": "reduce",
    "production": 29
   },
   "?[": {
    "type": "reduce",
    "production": 29
   },
   ")": {
    "type": "reduce",
    "production": 29
   },
   "]": {
    "type": "reduce",
    "production": 29
   },
   ",": {
    "type": "reduce",
    "production": 29
   },
   ":": {
    "type": "reduce",
    "production": 29
   },
   "}": {
    "type": "reduce",
    "production": 29
   }
  }
 ],
 "goto": [
  {
   "Expr": 1,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {
   "Unary": 36,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Unary": 37,
   "Postfix": 11,
   "Primary": 12
  },
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {
   "Expr": 43,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Elems": 44,
   "ElemList": 45,
   "Expr": 46,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Entries": 47,
   "EntryList": 48,
   "Entry": 49,
   "Expr": 50,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Expr": 51,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Or": 52,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "And": 53,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Rel": 54,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Rel": 55,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Rel": 56,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Rel": 57,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Rel": 58,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Rel": 59,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Rel": 60,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Add": 61,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Add": 62,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Mul": 63,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Mul": 64,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Mul": 65,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {},
  {},
  {},
  {},
  {
   "Expr": 68,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Expr": 69,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Args": 70,
   "ArgList": 71,
   "Expr": 72,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {
   "Expr": 86,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {},
  {
   "Entry": 87,
   "Expr": 50,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Expr": 88,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Expr": 89,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Args": 90,
   "ArgList": 71,
   "Expr": 72,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {
   "Args": 91,
   "ArgList": 71,
   "Expr": 72,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {},
  {},
  {},
  {
   "Expr": 92,
   "Cond": 2,
   "Or": 3,
   "And": 4,
   "Rel": 5,
   "Add": 6,
   "Mul": 7,
   "Unary": 8,
   "Postfix": 11,
   "Primary": 12
  },
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {},
  {}
 ],
 "productions": [
  {
   "lhs": "Expr",
   "length": 1
  },
  {
   "lhs": "Cond",
   "length": 1
  },
  {
   "lhs": "Cond",
   "length": 5
  },
  {
   "lhs": "Or",
   "length": 3
  },
  {
   "lhs": "Or",
   "length": 1
  },
  {
   "lhs": "And",
   "length": 3
  },
  {
   "lhs": "And",
   "length": 1
  },
  {
   "lhs": "Rel",
   "length": 3
  },
  {
   "lhs": "Rel",
   "length": 3
  },
  {
   "lhs": "Rel",
   "length": 3
  },
  {
   "lhs": "Rel",
   "length": 3
  },
  {
   "lhs": "Rel",
   "length": 3
  },
  {
   "lhs": "Rel",
   "length": 3
  },
  {
   "lhs": "Rel",
   "length": 3
  },
  {
   "lhs": "Rel",
   "length": 1
  },
  {
   "lhs": "Add",
   "length": 3
  },
  {
   "lhs": "Add",
   "length": 3
  },
  {
   "lhs": "Add",
   "length": 1
  },
  {
   "lhs": "Mul",
   "length": 3
  },
  {
   "lhs": "Mul",
   "length": 3
  },
  {
   "lhs": "Mul",
   "length": 3
  },
  {
   "lhs": "Mul",
   "length": 1
  },
  {
   "lhs": "Unary",
   "length": 2
  },
  {
   "lhs": "Unary",
   "length": 2
  },
  {
   "lhs": "Unary",
   "length": 1
  },
  {
   "lhs": "Postfix",
   "length": 1
  },
  {
   "lhs": "Postfix",
   "length": 3
  },
  {
   "lhs": "Postfix",
   "length": 6
  },
  {
   "lhs": "Postfix",
   "length": 3
  },
  {
   "lhs": "Postfix",
   "length": 6
  },
  {
   "lhs": "Postfix",
   "length": 4
  },
  {
   "lhs": "Postfix",
   "length": 4
  },
  {
   "lhs": "Primary",
   "length": 1
  },
  {
   "lhs": "Primary",
   "length": 1
  },
  {
   "lhs": "Primary",
   "length": 1
  },
  {
   "lhs": "Primary",
   "length": 1
  },
  {
   "lhs": "Primary",
   "length": 1
  },
  {
   "lhs": "Primary",
   "length": 4
  },
  {
   "lhs": "Primary",
   "length": 3
  },
  {
   "lhs": "Primary",
   "length": 3
  },
  {
   "lhs": "Primary",
   "length": 3
  },
  {
   "lhs": "Args",
   "length": 0
  },
  {
   "lhs": "Args",
   "length": 1
  },
  {
   "lhs": "Args",
   "length": 2
  },
  {
   "lhs": "ArgList",
   "length": 1
  },
  {
   "lhs": "ArgList",
   "length": 3
  },
  {
   "lhs": "Elems",
   "length": 0
  },
  {
   "lhs": "Elems",
   "length": 1
  },
  {
   "lhs": "Elems",
   "length": 2
  },
  {
   "lhs": "ElemList",
   "length": 1
  },
  {
   "lhs": "ElemList",
   "length": 3
  },
  {
   "lhs": "Entries",
   "length": 0
  },
  {
   "lhs": "Entries",
   "length": 1
  },
  {
   "lhs": "Entries",
   "length": 2
  },
  {
   "lhs": "EntryList",
   "length": 1
  },
  {
   "lhs": "EntryList",
   "length": 3
  },
  {
   "lhs": "Entry",
   "length": 3
  }
 ]
};

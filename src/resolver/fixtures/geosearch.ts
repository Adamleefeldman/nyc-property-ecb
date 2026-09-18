// Live GeoSearch (/v2/search?size=5) responses, captured 2026-09-18, trimmed to the fields we read.
// Note: confidence is 0.8 and match_type is "fallback" on every feature, including wrong streets.

export interface GeoFeatureFixture {
  label: string; housenumber?: string; street?: string; borough?: string;
  confidence: number; match_type: string; addendum: { pad: { bbl?: string; bin?: string; version?: string } };
}

/** 350 5th Avenue, Manhattan */
export const ESB: { query: string; features: GeoFeatureFixture[] } = {
  "query": "350 5th Avenue, Manhattan",
  "features": [
    {
      "label": "350 5 AVENUE, New York, NY, USA",
      "housenumber": "350",
      "street": "5 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1008350041",
          "bin": "1015862",
          "version": "26c"
        }
      }
    },
    {
      "label": "350 5 AVENUE, Brooklyn, NY, USA",
      "housenumber": "350",
      "street": "5 AVENUE",
      "borough": "Brooklyn",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "3009810111",
          "bin": "3021057",
          "version": "26c"
        }
      }
    },
    {
      "label": "350A 5 AVENUE, New York, NY, USA",
      "housenumber": "350A",
      "street": "5 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1008350041",
          "bin": "1015862",
          "version": "26c"
        }
      }
    },
    {
      "label": "350B 5 AVENUE, New York, NY, USA",
      "housenumber": "350B",
      "street": "5 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1008350041",
          "bin": "1015862",
          "version": "26c"
        }
      }
    },
    {
      "label": "350 5 STREET, Brooklyn, NY, USA",
      "housenumber": "350",
      "street": "5 STREET",
      "borough": "Brooklyn",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "3009880011",
          "bin": "3021392",
          "version": "26c"
        }
      }
    }
  ]
};

/** 37-15 82nd Street, Queens */
export const QUEENS_HYPHEN: { query: string; features: GeoFeatureFixture[] } = {
  "query": "37-15 82nd Street, Queens",
  "features": [
    {
      "label": "37-15 82 STREET, Jackson Heights, NY, USA",
      "housenumber": "37-15",
      "street": "82 STREET",
      "borough": "Queens",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "4014700059",
          "bin": "4036223",
          "version": "26c"
        }
      }
    },
    {
      "label": "37-37 82 STREET, Jackson Heights, NY, USA",
      "housenumber": "37-37",
      "street": "82 STREET",
      "borough": "Queens",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "4014700059",
          "bin": "4036223",
          "version": "26c"
        }
      }
    },
    {
      "label": "37 82 STREET, Brooklyn, NY, USA",
      "housenumber": "37",
      "street": "82 STREET",
      "borough": "Brooklyn",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "3059750125",
          "bin": "3150670",
          "version": "26c"
        }
      }
    },
    {
      "label": "37 GARAGE 82 STREET, Brooklyn, NY, USA",
      "housenumber": "37 GARAGE",
      "street": "82 STREET",
      "borough": "Brooklyn",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "3059750125",
          "bin": "3361856",
          "version": "26c"
        }
      }
    },
    {
      "label": "15 82 STREET, Brooklyn, NY, USA",
      "housenumber": "15",
      "street": "82 STREET",
      "borough": "Brooklyn",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "3059750136",
          "bin": "3150673",
          "version": "26c"
        }
      }
    }
  ]
};

/** 15 Central Park West Apt 12B, Manhattan */
export const CPW15_UNIT: { query: string; features: GeoFeatureFixture[] } = {
  "query": "15 Central Park West Apt 12B, Manhattan",
  "features": [
    {
      "label": "15 CENTRAL PARK WEST, New York, NY, USA",
      "housenumber": "15",
      "street": "CENTRAL PARK WEST",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1011147503",
          "bin": "1087839",
          "version": "26c"
        }
      }
    },
    {
      "label": "6601 CENTRAL PARK NEAR CENTRAL PARK W, New York, NY, USA",
      "housenumber": "6601",
      "street": "CENTRAL PARK NEAR CENTRAL PARK W",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1011110001",
          "bin": "1085773",
          "version": "26c"
        }
      }
    },
    {
      "label": "6601 CENTRAL PK-NEAR CENTRAL PARK W, New York, NY, USA",
      "housenumber": "6601",
      "street": "CENTRAL PK-NEAR CENTRAL PARK W",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1011110001",
          "bin": "1085773",
          "version": "26c"
        }
      }
    },
    {
      "label": "66-01 CENTRAL PK-NEAR CENTRAL PARK W, New York, NY, USA",
      "housenumber": "66-01",
      "street": "CENTRAL PK-NEAR CENTRAL PARK W",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1011110001",
          "bin": "1085773",
          "version": "26c"
        }
      }
    },
    {
      "label": "66-01 CENTRAL PARK NEAR CENTRAL PARK W, New York, NY, USA",
      "housenumber": "66-01",
      "street": "CENTRAL PARK NEAR CENTRAL PARK W",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1011110001",
          "bin": "1085773",
          "version": "26c"
        }
      }
    }
  ]
};

/** 1820 Riverside Ave, Bronx */
export const WRONG_STREET: { query: string; features: GeoFeatureFixture[] } = {
  "query": "1820 Riverside Ave, Bronx",
  "features": [
    {
      "label": "1820 GILDERSLEEVE AVENUE, Bronx, NY, USA",
      "housenumber": "1820",
      "street": "GILDERSLEEVE AVENUE",
      "borough": "Bronx",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "2034420058",
          "bin": "2019980",
          "version": "26c"
        }
      }
    },
    {
      "label": "1820 BARNS AVENUE, Bronx, NY, USA",
      "housenumber": "1820",
      "street": "BARNS AVENUE",
      "borough": "Bronx",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "2040540014",
          "bin": "2043667",
          "version": "26c"
        }
      }
    },
    {
      "label": "1820 NEREID AVENUE, Bronx, NY, USA",
      "housenumber": "1820",
      "street": "NEREID AVENUE",
      "borough": "Bronx",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "2050520053",
          "bin": "2070106",
          "version": "26c"
        }
      }
    },
    {
      "label": "1820 PATTERSON AVENUE, Bronx, NY, USA",
      "housenumber": "1820",
      "street": "PATTERSON AVENUE",
      "borough": "Bronx",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "2034700031",
          "bin": "2000000",
          "version": "26c"
        }
      }
    },
    {
      "label": "1820 LAFAYETTE AVENUE, Bronx, NY, USA",
      "housenumber": "1820",
      "street": "LAFAYETTE AVENUE",
      "borough": "Bronx",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "2035990036",
          "bin": "2022199",
          "version": "26c"
        }
      }
    }
  ]
};

/** 350 5th Avenue */
export const NO_BOROUGH: { query: string; features: GeoFeatureFixture[] } = {
  "query": "350 5th Avenue",
  "features": [
    {
      "label": "350 5 AVENUE, New York, NY, USA",
      "housenumber": "350",
      "street": "5 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1008350041",
          "bin": "1015862",
          "version": "26c"
        }
      }
    },
    {
      "label": "350 5 AVENUE, Brooklyn, NY, USA",
      "housenumber": "350",
      "street": "5 AVENUE",
      "borough": "Brooklyn",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "3009810111",
          "bin": "3021057",
          "version": "26c"
        }
      }
    },
    {
      "label": "350A 5 AVENUE, New York, NY, USA",
      "housenumber": "350A",
      "street": "5 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1008350041",
          "bin": "1015862",
          "version": "26c"
        }
      }
    },
    {
      "label": "350B 5 AVENUE, New York, NY, USA",
      "housenumber": "350B",
      "street": "5 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1008350041",
          "bin": "1015862",
          "version": "26c"
        }
      }
    },
    {
      "label": "350 5 STREET, Brooklyn, NY, USA",
      "housenumber": "350",
      "street": "5 STREET",
      "borough": "Brooklyn",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "3009880011",
          "bin": "3021392",
          "version": "26c"
        }
      }
    }
  ]
};

/** 5th Avenue, Manhattan */
export const STREET_ONLY: { query: string; features: GeoFeatureFixture[] } = {
  "query": "5th Avenue, Manhattan",
  "features": [
    {
      "label": "6 5 AVENUE, New York, NY, USA",
      "housenumber": "6",
      "street": "5 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1005510001",
          "bin": "1008850",
          "version": "26c"
        }
      }
    },
    {
      "label": "13 5 AVENUE, New York, NY, USA",
      "housenumber": "13",
      "street": "5 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1005660001",
          "bin": "1009222",
          "version": "26c"
        }
      }
    },
    {
      "label": "43 5 AVENUE, New York, NY, USA",
      "housenumber": "43",
      "street": "5 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1005690001",
          "bin": "1009272",
          "version": "26c"
        }
      }
    },
    {
      "label": "49 5 AVENUE, New York, NY, USA",
      "housenumber": "49",
      "street": "5 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1005690005",
          "bin": "1009275",
          "version": "26c"
        }
      }
    },
    {
      "label": "57 5 AVENUE, New York, NY, USA",
      "housenumber": "57",
      "street": "5 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1005700005",
          "bin": "1009374",
          "version": "26c"
        }
      }
    }
  ]
};

/** 939 2nd Avenue, Manhattan */
export const AVE_939: { query: string; features: GeoFeatureFixture[] } = {
  "query": "939 2nd Avenue, Manhattan",
  "features": [
    {
      "label": "939 2 AVENUE, New York, NY, USA",
      "housenumber": "939",
      "street": "2 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1013230128",
          "bin": "1038249",
          "version": "26c"
        }
      }
    },
    {
      "label": "2 2 AVENUE, New York, NY, USA",
      "housenumber": "2",
      "street": "2 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1004420001",
          "bin": "1000000",
          "version": "26c"
        }
      }
    },
    {
      "label": "1390 1/2 2 AVENUE, New York, NY, USA",
      "housenumber": "1390 1/2",
      "street": "2 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1014460151",
          "bin": "1044876",
          "version": "26c"
        }
      }
    },
    {
      "label": "7 1/2 2 AVENUE, New York, NY, USA",
      "housenumber": "7 1/2",
      "street": "2 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1004560029",
          "bin": "1079804",
          "version": "26c"
        }
      }
    },
    {
      "label": "2291 1/2 2 AVENUE, New York, NY, USA",
      "housenumber": "2291 1/2",
      "street": "2 AVENUE",
      "borough": "Manhattan",
      "confidence": 0.8,
      "match_type": "fallback",
      "addendum": {
        "pad": {
          "bbl": "1016670025",
          "bin": "1052623",
          "version": "26c"
        }
      }
    }
  ]
};


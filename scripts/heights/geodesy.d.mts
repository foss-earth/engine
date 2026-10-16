export declare function geodeticToEcef(longitudeDeg: number, latitudeDeg: number, heightMeters: number): [number, number, number];
export declare function ecefToGeodetic(point: ArrayLike<number>): { longitudeDeg: number; latitudeDeg: number; heightMeters: number };

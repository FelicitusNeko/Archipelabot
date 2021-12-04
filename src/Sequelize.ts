// Copyright 2021 FelicitusNeko
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Sequelize, ModelDefined, DataTypes } from "sequelize";

const sequelize = new Sequelize("sqlite::memory:");

interface YamlAttributes {
  code: string;
  userId: string;
  filename: string;
  description: string;
  games: string;
}
const YamlTable: ModelDefined<YamlAttributes, YamlAttributes> =
  sequelize.define(
    "Yaml",
    {
      code: {
        type: DataTypes.STRING(4),
        primaryKey: true,
        validate: {
          is: /[A-Z]{4}/,
        },
      },
      userId: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: {
          isNumeric: true,
          len: [16, 20],
        },
      },
      filename: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      description: {
        type: DataTypes.STRING(255),
        allowNull: false,
        defaultValue: "No description provided",
      },
      games: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: ["A Link to the Past"],
      },
    },
    {
      tableName: "yaml",
    }
  );

interface PlayerAttributes {
  userId: string;
  defaultCode: string;
}
const PlayerTable: ModelDefined<PlayerAttributes, PlayerAttributes> =
  sequelize.define(
    "Player",
    {
      userId: {
        type: DataTypes.STRING(20),
        primaryKey: true,
        validate: {
          isNumeric: true,
          len: [16, 20],
        },
      },
      defaultCode: {
        type: DataTypes.STRING(4),
        allowNull: false,
        validate: {
          is: /[A-Z]{4}/,
        },
      },
    },
    { tableName: "players" }
  );

interface GameAttributes {
  code: string;
  guildId: string;
  userId: string;
  active: boolean;
}
const GameTable: ModelDefined<GameAttributes, GameAttributes> =
  sequelize.define(
    "Game",
    {
      code: {
        type: DataTypes.STRING(4),
        primaryKey: true,
        validate: {
          is: /[A-Z]{4}/,
        },
      },
      guildId: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: {
          isNumeric: true,
          len: [16, 20],
        },
      },
      userId: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: {
          isNumeric: true,
          len: [16, 20],
        },
      },
      active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "games",
    }
  );

sequelize.sync();

export default sequelize;
export { YamlTable, PlayerTable, GameTable };
